import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from './app-error';

export type PaymentRole = 'CLIENT' | 'PROVIDER' | 'AFFILIATE';
export const paymentRole = (role: string | null | undefined): PaymentRole => {
  if (role === 'CLIENT' || role === 'PROVIDER' || role === 'AFFILIATE') return role;
  throw new AppError('طرق الدفع متاحة لحساب العميل ومقدم الخدمة والمسوق', 403);
};
export const hashPaymentState = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const normalizeIban = (value: string) => value.replace(/\s/g, '').toUpperCase();
export function isRajhiIban(value: string): boolean {
  // Saudi IBAN: SA + check digits + bank identifier 80 (Al Rajhi) + 18 account digits.
  const iban = normalizeIban(value);
  if (!/^SA\d{2}80\d{18}$/.test(iban)) return false;
  const numeric = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}
export const rajhiMethodSchema = z.object({
  accountHolder: z.string().trim().min(2, 'اسم صاحب الحساب مطلوب').max(160),
  iban: z.string().max(64).transform(normalizeIban).refine(isRajhiIban, 'أدخل آيبان سعوديًا صحيحًا تابعًا لمصرف الراجحي'),
  label: z.string().trim().max(60).optional(),
}).strict();

export function paymentEncryptionReady(): boolean {
  return /^[a-f\d]{64}$/i.test(process.env.PAYMENT_METHODS_ENCRYPTION_KEY ?? '');
}
function encryptionKey(): Buffer {
  if (!paymentEncryptionReady()) throw new AppError('إضافة طرق الدفع غير متاحة حاليًا، يرجى المحاولة لاحقًا', 503, undefined, 'PAYMENT_METHODS_NOT_CONFIGURED');
  return Buffer.from(process.env.PAYMENT_METHODS_ENCRYPTION_KEY!, 'hex');
}
export function encryptPaymentDetails(value: object, context: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decryptPaymentDetails<T>(value: string, context: string): T {
  const [version, iv, tag, data, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error('INVALID_PAYMENT_CIPHERTEXT');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
}
export const paymentContext = (userId: string, role: string, kind: string, environment: string) => `${userId}:${role}:${kind}:${environment}`;
export const paymentEnvironment = (): 'live' | 'sandbox' => process.env.PAYMENT_METHODS_ENV === 'live' || process.env.PLATFORM_DEPLOY_ENV === 'official' ? 'live' : 'sandbox';
export const maskedEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  const [host = '', ...suffix] = domain.split('.');
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${suffix.length ? '.' + suffix.join('.') : ''}`;
};

export function paypalConnectConfig() {
  const mode = process.env.PAYPAL_CONNECT_MODE;
  const clientId = process.env.PAYPAL_CONNECT_CLIENT_ID;
  const secret = process.env.PAYPAL_CONNECT_CLIENT_SECRET;
  const redirectUri = process.env.PAYPAL_CONNECT_RETURN_URL;
  if (!paymentEncryptionReady() || !clientId || !secret || !redirectUri || mode !== paymentEnvironment()) return null;
  try {
    const url = new URL(redirectUri);
    const hosts = mode === 'live' ? ['waseetai.com', 'www.waseetai.com'] : ['dev.waseetai.com'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/payment-methods/paypal-return') return null;
    if (mode === 'live' && process.env.PAYPAL_CONNECT_LIVE_APPROVED !== 'true') return null;
    return { mode: mode as 'sandbox' | 'live', clientId, secret, redirectUri,
      api: mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
      authorize: mode === 'live' ? 'https://www.paypal.com/connect' : 'https://www.sandbox.paypal.com/connect' };
  } catch { return null; }
}
