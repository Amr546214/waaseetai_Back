import crypto from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { decryptPaymentDetails, encryptPaymentDetails, hashPaymentState, maskedEmail, PaymentRole, paymentContext, paymentEncryptionReady, paymentEnvironment, paypalConnectConfig, rajhiMethodSchema } from '../utils/payment-methods';
import { paypalEmailChangeService } from './paypal-email-change.service';

type Actor = { userId: string; role: PaymentRole; sessionId: string };
type PaypalDetails = { email: string; subject: string | null; userId: string | null; emailVerified: boolean | null; accountVerified: boolean | null; connectedAt: string };
type BankDetails = { accountHolder: string; iban: string; label?: string };
type Db = Prisma.TransactionClient;

export class PaymentMethodsService {
  constructor(private readonly db = prisma, private readonly request: typeof fetch = fetch) {}
  private scope(a: Actor) { return { userId: a.userId, role: a.role as UserRole, environment: paymentEnvironment() }; }
  private async currentEmail(a: Actor, db: Db = this.db): Promise<string | null> {
    const where = { userId: a.userId }, select = { paypalPayoutEmail: true };
    const row = a.role === 'PROVIDER' ? await db.providerProfile.findUnique({ where, select })
      : a.role === 'CLIENT' ? await db.clientProfile.findUnique({ where, select }) : await db.affiliateProfile.findUnique({ where, select });
    return row?.paypalPayoutEmail?.trim().toLowerCase() || null;
  }
  private async lock(a: Actor, tx: Db) {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${a.userId} FOR UPDATE`;
  }
  private async audit(a: Actor, tx: Db, event: string) {
    await tx.accountAuditLog.create({ data: { userId: a.userId, category: 'SECURITY_CHANGE', eventType: event, title: 'تحديث طرق الدفع', actionText: 'تحديث طريقة الدفع للحساب', summary: 'تحديث طريقة دفع للحساب', source: 'USER', status: 'COMPLETED', metaData: { role: a.role, environment: paymentEnvironment() } } });
  }
  private details<T>(row: { userId: string; role: string; kind: string; environment: string; encryptedDetails: string }): T {
    return decryptPaymentDetails<T>(row.encryptedDetails, paymentContext(row.userId, row.role, row.kind, row.environment));
  }
  private async owned(a: Actor, id: string) {
    const row = await this.db.paymentMethod.findFirst({ where: { id, ...this.scope(a) } });
    if (!row) throw new AppError('طريقة الدفع غير موجودة', 404);
    return row;
  }
  async list(a: Actor) {
    const [rows, email] = await Promise.all([this.db.paymentMethod.findMany({ where: this.scope(a), orderBy: { createdAt: 'asc' } }), this.currentEmail(a)]);
    const methods = rows.map(row => {
      if (row.kind === 'ALRAJHI') {
        const d = this.details<BankDetails>(row);
        return { id: row.id, kind: row.kind, label: d.label || 'حساب الراجحي', hint: `SA•• •••• •••• •••• •••• ${d.iban.slice(-4)}`, status: 'UNVERIFIED', isDefault: false, canActivate: false, emailVerified: null, accountVerified: null };
      }
      const d = this.details<PaypalDetails>(row);
      const matches = d.email.toLowerCase() === email;
      const status = d.emailVerified !== true ? 'EMAIL_UNCONFIRMED' : matches ? 'CONNECTED' : 'NEEDS_ACTIVATION';
      return { id: row.id, kind: row.kind, label: 'PayPal', hint: maskedEmail(d.email), status, isDefault: row.isDefault && matches && d.emailVerified === true, canActivate: d.emailVerified === true && !matches, emailVerified: d.emailVerified, accountVerified: d.accountVerified };
    });
    // Always reflect the canonical legacy destination, including changes from old profile screens.
    const linkedMatches = rows.some(row => row.kind === 'PAYPAL' && this.details<PaypalDetails>(row).email.toLowerCase() === email);
    const legacyPaypal = email && !linkedMatches ? { hint: maskedEmail(email), status: 'LEGACY_UNVERIFIED' } : null;
    const config = paypalConnectConfig();
    return { methods, legacyPaypal, role: a.role, environment: paymentEnvironment(), capabilities: { paypalConnect: !!config, paypalConnectOrigin: config ? new URL(config.redirectUri).origin : null, bankSave: paymentEncryptionReady(), bankVerification: false } };
  }
  async bank(a: Actor, raw: unknown) {
    const parsed = rajhiMethodSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('راجع بيانات حساب الراجحي', 400, parsed.error.issues.map(i => ({ field: i.path.join('.'), path: i.path.join('.'), message: i.message })));
    const scope = this.scope(a), kind = 'ALRAJHI';
    const encryptedDetails = encryptPaymentDetails(parsed.data, paymentContext(a.userId, a.role, kind, scope.environment));
    await this.db.$transaction(async tx => {
      await this.lock(a, tx);
      await tx.paymentMethod.upsert({ where: { userId_role_kind_environment: { ...scope, kind } }, create: { ...scope, kind, encryptedDetails }, update: { encryptedDetails, isDefault: false } });
      await this.audit(a, tx, 'PAYMENT_METHOD_BANK_SAVED');
    });
    return this.list(a);
  }
  async detail(a: Actor, id: string) {
    const row = await this.owned(a, id);
    if (row.kind !== 'ALRAJHI') throw new AppError('إعادة الربط مطلوبة لتغيير حساب PayPal', 400);
    return this.details<BankDetails>(row);
  }
  async remove(a: Actor, id: string) {
    await this.db.$transaction(async tx => {
      await this.lock(a, tx);
      const row = await tx.paymentMethod.findFirst({ where: { id, ...this.scope(a) } });
      if (!row) throw new AppError('طريقة الدفع غير موجودة', 404);
      // Disconnect identity proof only: existing withdrawals and canonical payout data stay intact.
      await tx.paymentMethod.delete({ where: { id } });
      await this.audit(a, tx, 'PAYMENT_METHOD_DISCONNECTED');
    });
    return this.list(a);
  }
  async makeDefault(a: Actor, id: string) {
    await this.db.$transaction(async tx => {
      await this.lock(a, tx);
      const row = await tx.paymentMethod.findFirst({ where: { id, ...this.scope(a) } });
      if (!row) throw new AppError('طريقة الدفع غير موجودة', 404);
      if (row.kind !== 'PAYPAL') throw new AppError('تم حفظ الحساب البنكي، لكن التحقق البنكي والتحويل إليه غير متاحين حاليًا', 409);
      const d = this.details<PaypalDetails>(row);
      if (d.emailVerified !== true || d.email.toLowerCase() !== await this.currentEmail(a, tx)) throw new AppError('أكمل تأكيد حساب PayPal أولًا', 409);
      await tx.paymentMethod.updateMany({ where: this.scope(a), data: { isDefault: false } });
      await tx.paymentMethod.update({ where: { id }, data: { isDefault: true } });
      await this.audit(a, tx, 'PAYMENT_METHOD_DEFAULT_CHANGED');
    });
    return this.list(a);
  }
  async start(a: Actor) {
    const config = paypalConnectConfig();
    if (!config) throw new AppError('ربط PayPal غير متاح حاليًا، يرجى المحاولة لاحقًا', 503, undefined, 'PAYPAL_CONNECT_UNAVAILABLE');
    const state = crypto.randomBytes(32).toString('base64url');
    await this.db.$transaction(async tx => {
      // One outstanding attempt per actor; retain spent attempts until expiry for replay refusal.
      await this.lock(a, tx);
      await tx.paymentMethodAuthorization.deleteMany({ where: { userId: a.userId, expiresAt: { lt: new Date() } } });
      await tx.paymentMethodAuthorization.updateMany({ where: { ...this.scope(a), sessionId: a.sessionId, consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.paymentMethodAuthorization.create({ data: { stateHash: hashPaymentState(state), ...this.scope(a), sessionId: a.sessionId, expiresAt: new Date(Date.now() + 600_000) } });
    });
    const url = new URL(config.authorize);
    url.search = new URLSearchParams({ flowEntry: 'static', client_id: config.clientId, response_type: 'code', scope: 'openid email https://uri.paypal.com/services/paypalattributes', redirect_uri: config.redirectUri, state }).toString();
    return { url: url.toString() };
  }
  private async paypalJson(url: string, options: RequestInit): Promise<any> {
    try {
      const res = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error('PROVIDER_REJECTED');
      const text = await res.text();
      if (text.length > 65536) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      return JSON.parse(text);
    } catch { throw new AppError('تعذر إكمال الربط مع PayPal، أعد المحاولة من زر الربط', 502, undefined, 'PAYPAL_CONNECT_FAILED'); }
  }
  async complete(a: Actor, code: string, state: string) {
    const config = paypalConnectConfig();
    if (!config) throw new AppError('ربط PayPal غير متاح حاليًا', 503);
    // Atomic durable claim BEFORE any external exchange. Failed exchanges need a fresh authorization.
    const claim = await this.db.paymentMethodAuthorization.updateMany({ where: { stateHash: hashPaymentState(state), ...this.scope(a), sessionId: a.sessionId, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (claim.count !== 1) throw new AppError('محاولة الربط منتهية أو غير صالحة، ابدأ الربط من جديد بنفس الحساب والدور', 400, undefined, 'PAYPAL_STATE_INVALID');
    const token = await this.paypalJson(`${config.api}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }).toString() });
    if (typeof token.access_token !== 'string' || !token.access_token) throw new AppError('تعذر تأكيد حساب PayPal', 502);
    const info = await this.paypalJson(`${config.api}/v1/identity/openidconnect/userinfo?schema=openid`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    // Only provider-returned fields are persisted. No raw token/response is stored or logged.
    const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
    const subject = identifier(info.sub), userId = identifier(info.user_id);
    if (typeof info.email !== 'string' || info.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email) || (!subject && !userId)) throw new AppError('لم تسمح PayPal بمشاركة بيانات الحساب المطلوبة', 422);
    const d: PaypalDetails = { email: info.email.trim().toLowerCase(), subject, userId, emailVerified: typeof info.email_verified === 'boolean' ? info.email_verified : null, accountVerified: typeof info.verified_account === 'boolean' ? info.verified_account : null, connectedAt: new Date().toISOString() };
    const scope = this.scope(a), kind = 'PAYPAL';
    await this.db.$transaction(async tx => {
      await this.lock(a, tx);
      const encryptedDetails = encryptPaymentDetails(d, paymentContext(a.userId, a.role, kind, scope.environment));
      await tx.paymentMethod.upsert({ where: { userId_role_kind_environment: { ...scope, kind } }, create: { ...scope, kind, encryptedDetails }, update: { encryptedDetails, isDefault: false } });
      await this.audit(a, tx, 'PAYMENT_METHOD_PAYPAL_CONNECTED');
    });
    return this.list(a);
  }
  async activate(a: Actor, id: string, ip?: string) {
    const row = await this.owned(a, id);
    if (row.kind !== 'PAYPAL') throw new AppError('التحويل البنكي غير متاح حاليًا', 409);
    const d = this.details<PaypalDetails>(row);
    if (d.emailVerified !== true) throw new AppError('أكّد بريدك لدى PayPal ثم أعد الربط', 409);
    if (await this.currentEmail(a) === d.email) return { otpRequired: false, ...(await this.list(a)) };
    if (a.role === 'PROVIDER') {
      // Preserve the existing account-email OTP + 24h withdrawal freeze, including initial additions.
      const data = await paypalEmailChangeService.requestChange(a.userId, d.email, ip);
      return { otpRequired: true, ...data };
    }
    await this.db.$transaction(async tx => {
      await this.lock(a, tx);
      if (a.role === 'CLIENT') await tx.clientProfile.update({ where: { userId: a.userId }, data: { paypalPayoutEmail: d.email } });
      else await tx.affiliateProfile.update({ where: { userId: a.userId }, data: { paypalPayoutEmail: d.email } });
      await this.audit(a, tx, 'PAYMENT_METHOD_PAYPAL_ACTIVATED');
    });
    return { otpRequired: false, ...(await this.list(a)) };
  }
  async confirm(a: Actor, id: string, code: string) {
    if (a.role !== 'PROVIDER') throw new AppError('هذا التأكيد خاص بحساب مقدم الخدمة', 403);
    const row = await this.owned(a, id);
    if (row.kind !== 'PAYPAL') throw new AppError('طريقة غير صحيحة', 400);
    const d = this.details<PaypalDetails>(row);
    const otp = await this.db.otpVerification.findFirst({ where: { userId: a.userId, type: 'EMAIL', context: { path: ['purpose'], equals: 'PAYPAL_EMAIL_CHANGE' } }, orderBy: { createdAt: 'desc' } });
    if (d.emailVerified !== true || (otp?.context as { newEmail?: string } | null)?.newEmail !== d.email) throw new AppError('ابدأ تأكيد بريد السحب لهذه الطريقة مجددًا', 409);
    await paypalEmailChangeService.confirmChange(a.userId, code);
    return this.list(a);
  }
}
export const paymentMethodsService = new PaymentMethodsService();
