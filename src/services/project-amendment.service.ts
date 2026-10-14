import { AmendmentRequesterRole, AmendmentStatus, AmendmentType, ContractStatus, OtpType } from '@prisma/client';
import { prisma } from '../config/db';
import crypto from 'crypto';
import { AppError } from '../utils/app-error';
import { round2 } from '../utils/money';
import { isV2Escrow } from '../utils/escrow-commission';
import { OtpPurpose, OTP_MAX_ATTEMPTS, OTP_LOCKED_MESSAGE } from '../utils/otp-purpose';
import { applyAmendment, effectiveParts, termsFingerprint, FUNDING_AUTHORIZATION_TTL_MS } from './amendment-apply.service';
import { hasActiveDispute } from './amendment-dispute-guard';
import { notificationService } from './notification.service';
import { projectProgressService } from './project-progress.service';
import { providerNotifications } from './provider-notifications.service';
import { clientNotifications, clientNotificationFor } from './client-notifications.service';

const AMENDMENT_TYPES: AmendmentType[] = ['SCOPE', 'BUDGET', 'DURATION', 'MIXED'];
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 5000;

// Rejects NaN/Infinity/non-numbers outright rather than silently coercing
// them to "not supplied" — a client that sent a bad number must see a 400,
// never have it quietly become null and pass validation under a different
// reading of the request.
const parseOptionalFiniteNumber = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError(`قيمة ${label} غير صالحة`, 400);
  return value;
};

const parseOptionalFiniteInteger = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) throw new AppError(`قيمة ${label} غير صالحة`, 400);
  return value;
};


type AmendmentInput = { title?: string; description?: string; type?: string; budgetDelta?: number; durationDeltaDays?: number };

// Shared by the client's and the provider's "create amendment": the declared type must genuinely match what was supplied.
// (Extracted unchanged from ProjectAmendmentService.createAmendment; the client path behaves exactly as before.)
const validateAmendmentInput = (input: AmendmentInput) => {
  const title = input.title?.trim();
  if (!title) throw new AppError('أضف عنوانًا لطلب التعديل', 400);
  if (title.length > TITLE_MAX_LENGTH) throw new AppError(`العنوان طويل جدًا (الحد الأقصى ${TITLE_MAX_LENGTH} حرفًا)`, 400);

  const type = input.type as AmendmentType;
  if (!AMENDMENT_TYPES.includes(type)) throw new AppError('نوع التعديل غير صالح', 400);

  const description = input.description?.trim() || null;
  if (description && description.length > DESCRIPTION_MAX_LENGTH) throw new AppError(`الوصف طويل جدًا (الحد الأقصى ${DESCRIPTION_MAX_LENGTH} حرفًا)`, 400);

  // NaN/Infinity/wrong-typed values are rejected outright (400), not
  // silently coerced to "not supplied" — see parseOptionalFinite* above.
  let budgetDelta = parseOptionalFiniteNumber(input.budgetDelta, 'الميزانية');
  if (budgetDelta === 0) budgetDelta = null; // a zero delta means "no real budget change", same as omitting it
  let durationDeltaDays = parseOptionalFiniteInteger(input.durationDeltaDays, 'المدة');
  if (durationDeltaDays === 0) durationDeltaDays = null; // same for duration

  if (budgetDelta !== null && Math.abs(round2(budgetDelta) - budgetDelta) > 1e-9) throw new AppError('قيمة الميزانية يجب ألا تتجاوز خانتين عشريتين', 400);

  const hasScope = !!(description && description.length > 0);
  const hasBudget = budgetDelta !== null;
  const hasDuration = durationDeltaDays !== null;

  // The declared type must genuinely match what was supplied — a client
  // can never claim type=BUDGET while only a duration change (or nothing
  // meaningful at all) was actually provided.
  if (type === AmendmentType.SCOPE && !hasScope) {
    throw new AppError('تعديل النطاق يتطلب وصفًا يوضح التغيير المطلوب', 400);
  }
  if (type === AmendmentType.BUDGET && !hasBudget) {
    throw new AppError('تعديل الميزانية يتطلب قيمة تغيير فعلية غير صفرية', 400);
  }
  if (type === AmendmentType.DURATION && !hasDuration) {
    throw new AppError('تعديل المدة يتطلب عدد أيام تغيير فعلي غير صفري', 400);
  }
  if (type === AmendmentType.MIXED) {
    const dimensionCount = [hasScope, hasBudget, hasDuration].filter(Boolean).length;
    if (dimensionCount < 2) throw new AppError('التعديل المتعدد يتطلب بُعدين على الأقل من التغيير: نطاق أو ميزانية أو مدة', 400);
  }
  return { title, type, description, budgetDelta, durationDeltaDays };
};

// Legacy rows: an amendment APPROVED before the amendment-effective release (appliedAt NULL) was only RECORDED; it is never re-applied.
export const AMENDMENT_EFFECT = 'RECORD_ONLY' as const;
export const AMENDMENT_EFFECT_NOTE = 'القرار يُسجَّل للمتابعة فقط ولا يغيّر سعر العقد أو مدته أو الضمان حاليًا.';
export const AMENDMENT_APPLIED_NOTE = 'طُبّق التعديل على العقد والضمان والمراحل.';
export const AMENDMENT_PENDING_NOTE = 'لن يتغيّر العقد أو الضمان أو المحفظة قبل موافقة الطرف الآخر، وعند الموافقة يُطبَّق التعديل فورًا.';
export const AMENDMENT_NONE_NOTE = 'لم يتغيّر شيء في العقد.';

export type AmendmentEffect = 'APPLIED' | 'RECORD_ONLY' | 'PENDING' | 'NONE';
// APPLIED: changed the contract (appliedAt set in the same transaction). RECORD_ONLY: legacy approved row, status only. PENDING: will apply on approval. NONE: rejected / cancelled.
export const amendmentEffectOf = (row: { status: string; appliedAt?: Date | null }): AmendmentEffect =>
  row.appliedAt ? 'APPLIED' : row.status === 'APPROVED' ? 'RECORD_ONLY' : row.status === 'PENDING_OTHER_PARTY' ? 'PENDING' : 'NONE';
const EFFECT_NOTES: Record<AmendmentEffect, string> = { APPLIED: AMENDMENT_APPLIED_NOTE, RECORD_ONLY: AMENDMENT_EFFECT_NOTE, PENDING: AMENDMENT_PENDING_NOTE, NONE: AMENDMENT_NONE_NOTE };

const toPublicAmendment = (row: any, conversationId: string | null) => {
  const effect = amendmentEffectOf(row);
  const parts = effectiveParts(row);
  return {
    id: row.id,
    projectId: row.projectId,
    projectTitle: row.project.title,
    contractId: row.contractId,
    contractRef: `CT-${row.contractId.slice(0, 6).toUpperCase()}`,
    providerId: row.providerId,
    providerName: `${row.provider.firstName || 'مقدم الخدمة'} ${row.provider.lastName || ''}`.trim(),
    requestedByRole: row.requestedByRole,
    type: row.type,
    title: row.title,
    description: row.description,
    budgetDelta: row.budgetDelta,
    durationDeltaDays: row.durationDeltaDays,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    respondedAt: row.respondedAt,
    effect,
    effectNote: EFFECT_NOTES[effect],
    appliedAt: row.appliedAt ?? null,
    priceBefore: row.priceBefore ?? null,
    priceAfter: row.priceAfter ?? null,
    durationBefore: row.durationBefore ?? null,
    durationAfter: row.durationAfter ?? null,
    addedStageId: row.addedStageId ?? null,
    // A budget INCREASE needs the client's OTP-authorized payment before it can become effective.
    needsClientPayment: parts.budget > 0,
    // Valid only while it is not expired and the contract terms are still the ones it was given for; never an open-ended permission.
    fundingAuthorized: row.fundingAuthorizedAt != null && Date.now() - new Date(row.fundingAuthorizedAt).getTime() <= FUNDING_AUTHORIZATION_TTL_MS && (!row.contract || row.fundingAuthorizedTerms === termsFingerprint(row.contract)),
    fundingAuthorizedUntil: row.fundingAuthorizedAt != null ? new Date(new Date(row.fundingAuthorizedAt).getTime() + FUNDING_AUTHORIZATION_TTL_MS).toISOString() : null,
    // The contract's CURRENT price / duration (what the financial preview is computed from); null when unknown.
    contractPrice: row.contract?.price ?? null,
    contractDurationDays: row.contract?.durationDays ?? null,
    conversationId
  };
};

const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
const PAYMENT_OTP_TTL_MS = 2 * 60 * 1000;

export class ProjectAmendmentService {
  // Resolves the single real conversation for a given project+provider pair,
  // reusing the same unique relationship the rest of the app already relies
  // on (Conversation.@@unique([projectId, providerId])) — never guesses or
  // falls back to an unrelated conversation.
  private async resolveConversationIds(pairs: { projectId: string; providerId: string }[]) {
    const uniquePairs = Array.from(new Map(pairs.map(p => [`${p.projectId}:${p.providerId}`, p])).values());
    if (!uniquePairs.length) return new Map<string, string>();
    const conversations = await prisma.conversation.findMany({
      where: { OR: uniquePairs.map(p => ({ projectId: p.projectId, providerId: p.providerId })) },
      select: { id: true, projectId: true, providerId: true }
    });
    return new Map(conversations.map(c => [`${c.projectId}:${c.providerId}`, c.id]));
  }

  // Real amendments belonging to the authenticated client only — ownership is
  // enforced at the Prisma WHERE clause itself, not by post-filtering.
  async listAmendments(clientId: string) {
    const rows = await prisma.projectAmendment.findMany({
      where: { clientId },
      orderBy: { updatedAt: 'desc' },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true } },
        contract: { select: { price: true, durationDays: true, termsVersion: true } }
      }
    });
    const convMap = await this.resolveConversationIds(rows.map(r => ({ projectId: r.projectId, providerId: r.providerId })));
    return rows.map(row => toPublicAmendment(row, convMap.get(`${row.projectId}:${row.providerId}`) || null));
  }

  async createAmendment(
    clientId: string,
    projectId: string,
    input: { title?: string; description?: string; type?: string; budgetDelta?: number; durationDeltaDays?: number }
  ) {
    const { title, type, description, budgetDelta, durationDeltaDays } = validateAmendmentInput(input);

    // The client project page is keyed by the CONTRACT id for marketplace purchases (and by the project id elsewhere): accept either, then work with the real project id.
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId }, { id: projectId }], clientId, status: ContractStatus.ACTIVE }
    });
    if (!contract) throw new AppError('المشروع غير موجود أو العقد غير نشط أو لا تملك صلاحية إنشاء تعديل عليه', 403);
    projectId = contract.projectId;

    // At most ONE pending client-raised request per contract: the contract row is locked for the transaction (a harmless updatedAt touch), so
    // two simultaneous requests cannot both pass the "no pending request" check. The provider is notified; nothing about the contract changes.
    let providerNotificationId = '';
    const created = await prisma.$transaction(async tx => {
      const locked = await tx.contract.updateMany({ where: { id: contract.id, clientId, status: ContractStatus.ACTIVE }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new AppError('المشروع غير موجود أو العقد غير نشط أو لا تملك صلاحية إنشاء تعديل عليه', 403);

      const pending = await tx.projectAmendment.count({
        where: { contractId: contract.id, requestedByRole: AmendmentRequesterRole.CLIENT, status: AmendmentStatus.PENDING_OTHER_PARTY }
      });
      if (pending > 0) throw new AppError('لديك طلب تعديل معلّق لهذا المشروع بانتظار رد مقدم الخدمة', 409);

      const row = await tx.projectAmendment.create({
        data: {
          projectId,
          contractId: contract.id,
          clientId: contract.clientId,
          providerId: contract.providerId,
          requestedById: clientId,
          requestedByRole: AmendmentRequesterRole.CLIENT,
          type,
          title,
          description,
          budgetDelta,
          durationDeltaDays,
          status: AmendmentStatus.PENDING_OTHER_PARTY
        },
        include: {
          project: { select: { title: true } },
          provider: { select: { firstName: true, lastName: true } },
        contract: { select: { price: true, durationDays: true, termsVersion: true } }
        }
      });

      const providerNotification = await tx.notification.create({
        data: {
          userId: contract.providerId,
          title: 'طلب تعديل على مشروعك',
          message: `طلب العميل تعديلًا على المشروع: ${title}. ${AMENDMENT_PENDING_NOTE}`,
          type: 'PROJECT_AMENDMENT',
          category: 'PROJECTS',
          actionUrl: `/provider-overview/projects/active/progress/${contract.id}`,
          actionText: 'عرض المشروع',
          metadata: { projectId, amendmentId: row.id }
        }
      });
      providerNotificationId = providerNotification.id;
      return row;
    });
    // Delivered through the provider's saved channels (push / e-mail) once the row is committed.
    await providerNotifications.deliverStored([providerNotificationId]);

    const convMap = await this.resolveConversationIds([{ projectId: created.projectId, providerId: created.providerId }]);
    return toPublicAmendment(created, convMap.get(`${created.projectId}:${created.providerId}`) || null);
  }

  // ── Provider side ───────────────────────────────────────────────────────────────────────────────────────────────
  // The provider's own amendment requests for ONE project (ownership enforced in the WHERE: providerId + projectId).
  async listProviderAmendments(providerId: string, projectId: string) {
    const rows = await prisma.projectAmendment.findMany({
      where: { providerId, projectId },
      orderBy: { createdAt: 'desc' },
      include: { project: { select: { title: true } }, provider: { select: { firstName: true, lastName: true } },
        contract: { select: { price: true, durationDays: true, termsVersion: true } } }
    });
    const convMap = await this.resolveConversationIds(rows.map(r => ({ projectId: r.projectId, providerId: r.providerId })));
    return rows.map(row => toPublicAmendment(row, convMap.get(`${row.projectId}:${row.providerId}`) || null));
  }

  // A formal change request raised by the PROVIDER: it waits (PENDING_OTHER_PARTY) and the client is notified. A request alone never changes the
  // contract price, duration, escrow or stages: only the client's approval applies it (applyAmendment).
  // At most ONE pending provider-raised request per contract: the contract row is locked for the transaction (a harmless updatedAt touch), so
  // two simultaneous requests cannot both pass the "no pending request" check.
  async createProviderAmendment(providerId: string, projectId: string, input: AmendmentInput) {
    const { title, type, description, budgetDelta, durationDeltaDays } = validateAmendmentInput(input);

    const contract = await prisma.contract.findFirst({ where: { projectId, providerId, status: ContractStatus.ACTIVE } });
    if (!contract) throw new AppError('المشروع غير موجود أو العقد غير نشط أو لا تملك صلاحية طلب تعديل عليه', 403);

    let clientNotificationId: string | null = null;
    const created = await prisma.$transaction(async tx => {
      const locked = await tx.contract.updateMany({ where: { id: contract.id, providerId, status: ContractStatus.ACTIVE }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new AppError('المشروع غير موجود أو العقد غير نشط أو لا تملك صلاحية طلب تعديل عليه', 403);

      const pending = await tx.projectAmendment.count({
        where: { contractId: contract.id, requestedByRole: AmendmentRequesterRole.PROVIDER, status: AmendmentStatus.PENDING_OTHER_PARTY }
      });
      if (pending > 0) throw new AppError('لديك طلب تعديل معلّق لهذا المشروع بانتظار رد العميل', 409);

      const row = await tx.projectAmendment.create({
        data: {
          projectId,
          contractId: contract.id,
          clientId: contract.clientId,
          providerId: contract.providerId,
          requestedById: providerId,
          requestedByRole: AmendmentRequesterRole.PROVIDER,
          type,
          title,
          description,
          budgetDelta,
          durationDeltaDays,
          status: AmendmentStatus.PENDING_OTHER_PARTY
        },
        include: { project: { select: { title: true } }, provider: { select: { firstName: true, lastName: true } },
        contract: { select: { price: true, durationDays: true, termsVersion: true } } }
      });

      clientNotificationId = (await tx.notification.create({ data: clientNotificationFor.amendmentRequested({ clientId: contract.clientId, projectId, amendmentId: row.id, title }) })).id;
      return row;
    });

    // Delivered through the client's saved channels (in-app push / e-mail) once the row is committed.
    await clientNotifications.deliverStored([clientNotificationId]);

    const convMap = await this.resolveConversationIds([{ projectId: created.projectId, providerId: created.providerId }]);
    return toPublicAmendment(created, convMap.get(`${created.projectId}:${created.providerId}`) || null);
  }

  private readonly amendmentInclude = {
    project: { select: { title: true } },
    provider: { select: { firstName: true, lastName: true } },
        contract: { select: { price: true, durationDays: true, termsVersion: true } }
  } as const;

  private async publicById(amendmentId: string) {
    const updated = await prisma.projectAmendment.findFirst({ where: { id: amendmentId }, include: this.amendmentInclude });
    const convMap = await this.resolveConversationIds([{ projectId: updated!.projectId, providerId: updated!.providerId }]);
    return { updated: updated!, data: toPublicAmendment(updated, convMap.get(`${updated!.projectId}:${updated!.providerId}`) || null) };
  }

  // Creates the contract's stage rows when none exist yet (idempotent), so the amendment always applies to a real stage plan.
  private async ensureStages(contractId: string) {
    await projectProgressService.ensureStages(contractId);
  }

  // ── Payment authorization (client, budget INCREASE) ─────────────────────────────────────────────────────────────
  // The code is purpose-bound (AMENDMENT_PAYMENT) AND bound to THIS amendment id and THIS amount: a payment-checkout code, a login code, a code of another
  // amendment, or a code issued for a different amount can never authorize it. 2 minutes, 5 wrong guesses, one-time use (consumed in the applying transaction).
  private async findPaymentOtp(userId: string, amendmentId: string) {
    const records = await prisma.otpVerification.findMany({ where: { userId, type: OtpType.EMAIL }, orderBy: { createdAt: 'desc' }, take: 20 });
    return records.find(r => (r.context as any)?.purpose === OtpPurpose.AMENDMENT_PAYMENT && (r.context as any)?.amendmentId === amendmentId) ?? null;
  }

  private async verifyPaymentOtp(userId: string, amendment: { id: string; contractId: string }, amount: number, otpCode: unknown): Promise<string> {
    if (typeof otpCode !== 'string' || !otpCode.trim()) throw new AppError('رمز التحقق مطلوب لاعتماد دفع زيادة الميزانية', 400);
    const otp = await this.findPaymentOtp(userId, amendment.id);
    if (!otp) throw new AppError('لا يوجد رمز اعتماد دفع فعّال لهذا التعديل، اطلب رمزًا جديدًا', 400);
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await prisma.otpVerification.delete({ where: { id: otp.id } });
      throw new AppError(OTP_LOCKED_MESSAGE, 429);
    }
    if (otp.expiresAt < new Date()) {
      await prisma.otpVerification.delete({ where: { id: otp.id } });
      throw new AppError('انتهت صلاحية رمز التحقق، اطلب رمزًا جديدًا', 400);
    }
    // Bound to the contract terms at issue time: if they changed since (another amendment applied), the code is void.
    const contractNow = await prisma.contract.findUnique({ where: { id: amendment.contractId }, select: { termsVersion: true, price: true, durationDays: true } });
    if (!contractNow || (otp.context as any)?.terms !== termsFingerprint(contractNow)) {
      await prisma.otpVerification.delete({ where: { id: otp.id } });
      throw new AppError('تغيّرت شروط العقد بعد إصدار الرمز، فبطل. اطلب رمزًا جديدًا.', 400);
    }
    const boundAmount = Number((otp.context as any)?.amount);
    if (!Number.isFinite(boundAmount) || Math.abs(boundAmount - amount) > 0.005) {
      // Issued for another amount: never usable for this one.
      await prisma.otpVerification.delete({ where: { id: otp.id } });
      throw new AppError('رمز التحقق صادر لمبلغ مختلف، اطلب رمزًا جديدًا', 400);
    }
    if (otp.code !== otpCode.trim()) {
      if (otp.attempts + 1 >= OTP_MAX_ATTEMPTS) {
        await prisma.otpVerification.delete({ where: { id: otp.id } });
        throw new AppError(OTP_LOCKED_MESSAGE, 429);
      }
      await prisma.otpVerification.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new AppError('رمز التحقق غير صحيح', 400);
    }
    return otp.id;
  }

  // POST /client/projects/amendments/:id/payment-otp — sends the payment-authorization code (to the ACCOUNT EMAIL) for a pending budget increase.
  async initPaymentAuthorization(clientId: string, amendmentId: string) {
    const amendment = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, clientId } });
    if (!amendment) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
    if (amendment.status !== AmendmentStatus.PENDING_OTHER_PARTY) throw new AppError('طلب التعديل لم يعد معلّقًا', 409);
    const { budget } = effectiveParts(amendment);
    if (budget <= 0) throw new AppError('هذا الطلب لا يتطلب دفعًا', 400);

    // Advisory pre-checks (they only spare a useless code); the authoritative gates run inside the applying transaction.
    const escrow = await prisma.escrow.findUnique({ where: { projectId: amendment.projectId } });
    if (!escrow || escrow.status !== 'HELD') throw new AppError('لا يمكن تطبيق التعديل: ضمان المشروع غير محجوز', 409);
    if (!isV2Escrow(escrow)) throw new AppError('لا يمكن تعديل ميزانية عقد قديم قبل سياسة الرسوم الجديدة. تواصل مع الدعم.', 409);
    if (await hasActiveDispute(amendment.projectId, prisma as any)) throw new AppError('لا يمكن تطبيق التعديل أثناء وجود نزاع مفتوح على المشروع', 409);
    const user = await prisma.user.findUnique({ where: { id: clientId }, select: { email: true, walletBalance: true } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);
    const available = Number(user.walletBalance);
    if (available < budget) {
      throw new AppError('رصيد المحفظة غير كافٍ لتمويل زيادة الميزانية، اشحن المحفظة ثم أعد المحاولة', 409, [{ required: budget, available, shortfall: Math.max(0, round2(budget - available)) }]);
    }

    const contractForTerms = await prisma.contract.findUnique({ where: { id: amendment.contractId }, select: { termsVersion: true, price: true, durationDays: true } });
    if (!contractForTerms) throw new AppError('العقد غير موجود', 404);
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + PAYMENT_OTP_TTL_MS);
    const previous = await this.findPaymentOtp(clientId, amendmentId);
    if (previous) await prisma.otpVerification.deleteMany({ where: { id: previous.id } });
    await prisma.otpVerification.create({ data: { userId: clientId, code, type: OtpType.EMAIL, expiresAt, context: { purpose: OtpPurpose.AMENDMENT_PAYMENT, amendmentId, amount: budget, terms: termsFingerprint(contractForTerms), paymentReference: `AMD-${crypto.randomBytes(6).toString('hex').toUpperCase()}` } } });
    if (process.env.NODE_ENV === 'development') console.info(`[DEV AMENDMENT OTP] ${user.email}: ${code}`);
    notificationService.sendPaymentOtpEmail(user.email, code).catch(() => undefined);
    return { otpSentTo: maskEmail(user.email), expiresAt: expiresAt.toISOString(), amount: budget };
  }

  // POST /client/projects/amendments/:id/authorize-funding {otpCode} — the CLIENT who raised a budget increase authorizes the payment. Nothing is charged here:
  // it stores the authorization (bound to this amount); the provider's approval is what applies the amendment and debits the wallet in one transaction.
  async authorizeFunding(clientId: string, amendmentId: string, otpCode: unknown) {
    const amendment = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, clientId } });
    if (!amendment) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
    if (amendment.requestedByRole !== AmendmentRequesterRole.CLIENT) throw new AppError('اعتماد الدفع هنا لطلبات التعديل التي رفعها العميل؛ ادفع عند الموافقة على طلب مقدم الخدمة', 400);
    if (amendment.status !== AmendmentStatus.PENDING_OTHER_PARTY) throw new AppError('طلب التعديل لم يعد معلّقًا', 409);
    const { budget } = effectiveParts(amendment);
    if (budget <= 0) throw new AppError('هذا الطلب لا يتطلب دفعًا', 400);
    const otpId = await this.verifyPaymentOtp(clientId, amendment, budget, otpCode);
    await prisma.$transaction(async tx => {
      // Locks the contract so the terms read here are the committed ones the authorization is bound to.
      const locked = await tx.contract.updateMany({ where: { id: amendment.contractId, status: ContractStatus.ACTIVE }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new AppError('لا يمكن اعتماد الدفع: العقد غير نشط', 409);
      const contractNow = await tx.contract.findUnique({ where: { id: amendment.contractId }, select: { termsVersion: true, price: true, durationDays: true } });
      if (!contractNow) throw new AppError('العقد غير موجود', 404);
      const consumed = await tx.otpVerification.deleteMany({ where: { id: otpId, userId: clientId } });
      if (consumed.count !== 1) throw new AppError('رمز اعتماد الدفع استُخدم أو انتهى، اطلب رمزًا جديدًا', 409);
      const stored = await tx.projectAmendment.updateMany({
        where: { id: amendmentId, clientId, requestedByRole: AmendmentRequesterRole.CLIENT, status: AmendmentStatus.PENDING_OTHER_PARTY },
        data: { fundingAuthorizedAt: new Date(), fundingAuthorizedAmount: budget, fundingAuthorizedTerms: termsFingerprint(contractNow) }
      });
      if (stored.count !== 1) throw new AppError('طلب التعديل لم يعد معلّقًا', 409);
    });
    return (await this.publicById(amendmentId)).data;
  }

  // ── Answer ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Reject = one atomic conditional updateMany repeating every guard (ownership, requester role, still pending); the first decision wins.
  // Approve = applyAmendment() in ONE transaction (contract lock, claim, refusal rules, funding, escrow, stages, audit) — see amendment-apply.service.ts.
  // `otpCode` is only used by the CLIENT approving a provider-raised budget increase (the payment authorization).
  async respondToAmendment(clientId: string, amendmentId: string, decision: 'approve' | 'reject', otpCode?: string) {
    if (decision !== 'approve' && decision !== 'reject') throw new AppError('قرار غير صالح', 400);
    if (decision === 'approve') return this.approve('CLIENT', clientId, amendmentId, otpCode);

    const result = await prisma.projectAmendment.updateMany({
      where: { id: amendmentId, clientId, requestedByRole: AmendmentRequesterRole.PROVIDER, status: AmendmentStatus.PENDING_OTHER_PARTY },
      data: { status: AmendmentStatus.REJECTED, respondedAt: new Date() }
    });
    if (result.count !== 1) {
      const existing = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, clientId } });
      if (!existing) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
      if (existing.requestedByRole !== AmendmentRequesterRole.PROVIDER) throw new AppError('لا يمكنك الرد على طلب تعديل رفعته أنت', 403);
      throw new AppError('تم الرد على طلب التعديل هذا مسبقًا', 409);
    }
    const { updated, data } = await this.publicById(amendmentId);
    await providerNotifications.amendmentAnswered({ providerId: updated.providerId, projectId: updated.projectId, amendmentId, title: updated.title, decision });
    return data;
  }

  async respondToAmendmentAsProvider(providerId: string, amendmentId: string, decision: 'approve' | 'reject') {
    if (decision !== 'approve' && decision !== 'reject') throw new AppError('قرار غير صالح', 400);
    if (decision === 'approve') return this.approve('PROVIDER', providerId, amendmentId);

    const result = await prisma.projectAmendment.updateMany({
      where: { id: amendmentId, providerId, requestedByRole: AmendmentRequesterRole.CLIENT, status: AmendmentStatus.PENDING_OTHER_PARTY },
      data: { status: AmendmentStatus.REJECTED, respondedAt: new Date() }
    });
    if (result.count !== 1) {
      const existing = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, providerId } });
      if (!existing) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
      if (existing.requestedByRole !== AmendmentRequesterRole.CLIENT) throw new AppError('لا يمكنك الرد على طلب تعديل رفعته أنت', 403);
      throw new AppError('تم الرد على طلب التعديل هذا مسبقًا', 409);
    }
    const { updated, data } = await this.publicById(amendmentId);
    const clientNotification = await prisma.notification.create({ data: clientNotificationFor.amendmentAnswered({ clientId: updated.clientId, projectId: updated.projectId, amendmentId, title: updated.title, decision }) });
    await clientNotifications.deliverStored([clientNotification.id]);
    return data;
  }

  private async approve(side: 'CLIENT' | 'PROVIDER', userId: string, amendmentId: string, otpCode?: unknown) {
    const pre = await prisma.projectAmendment.findFirst({ where: side === 'CLIENT' ? { id: amendmentId, clientId: userId } : { id: amendmentId, providerId: userId } });
    if (!pre) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);
    const mustBeRaisedBy = side === 'CLIENT' ? AmendmentRequesterRole.PROVIDER : AmendmentRequesterRole.CLIENT;
    if (pre.requestedByRole !== mustBeRaisedBy) throw new AppError('لا يمكنك الرد على طلب تعديل رفعته أنت', 403);
    if (pre.status !== AmendmentStatus.PENDING_OTHER_PARTY) throw new AppError('تم الرد على طلب التعديل هذا مسبقًا', 409);

    const parts = effectiveParts(pre);
    if (parts.budget !== 0 || parts.days !== 0) await this.ensureStages(pre.contractId);
    // Provider-raised increase: the CLIENT's code authorizes the payment. Verified outside the transaction so wrong guesses are counted even when the answer is refused;
    // the code itself is consumed inside the applying transaction, so a refused approval leaves it valid.
    const paymentOtpId = side === 'CLIENT' && parts.budget > 0 ? await this.verifyPaymentOtp(userId, pre, parts.budget, otpCode) : null;

    await prisma.$transaction(tx => applyAmendment(tx, pre as any, { id: userId, role: side, paymentOtpId }));

    const { updated, data } = await this.publicById(amendmentId);
    if (side === 'CLIENT') {
      await providerNotifications.amendmentAnswered({ providerId: updated.providerId, projectId: updated.projectId, amendmentId, title: updated.title, decision: 'approve' });
    } else {
      const clientNotification = await prisma.notification.create({ data: clientNotificationFor.amendmentAnswered({ clientId: updated.clientId, projectId: updated.projectId, amendmentId, title: updated.title, decision: 'approve' }) });
      await clientNotifications.deliverStored([clientNotification.id]);
    }
    return data;
  }

  // The raiser withdraws a request that is still pending: nothing changes (no money moved, no authorization survives).
  async cancelAmendment(userId: string, role: 'CLIENT' | 'PROVIDER', amendmentId: string) {
    const requesterRole = role === 'CLIENT' ? AmendmentRequesterRole.CLIENT : AmendmentRequesterRole.PROVIDER;
    const result = await prisma.projectAmendment.updateMany({
      where: { id: amendmentId, requestedById: userId, requestedByRole: requesterRole, status: AmendmentStatus.PENDING_OTHER_PARTY },
      data: { status: AmendmentStatus.CANCELLED, respondedAt: new Date(), fundingAuthorizedAt: null, fundingAuthorizedAmount: null, fundingAuthorizedTerms: null }
    });
    if (result.count !== 1) {
      const existing = await prisma.projectAmendment.findFirst({ where: { id: amendmentId, requestedById: userId, requestedByRole: requesterRole } });
      if (!existing) throw new AppError('طلب التعديل غير موجود أو لا تملك صلاحية إلغائه', 403);
      throw new AppError('لا يمكن إلغاء طلب لم يعد معلّقًا', 409);
    }
    const { updated, data } = await this.publicById(amendmentId);
    // The other party is told (inbox always, channels per their preferences); a notification failure never fails the cancellation.
    try {
      if (role === 'CLIENT') await providerNotifications.amendmentCancelled({ providerId: updated.providerId, projectId: updated.projectId, amendmentId, title: updated.title });
      else await clientNotifications.send(clientNotificationFor.amendmentCancelled({ clientId: updated.clientId, projectId: updated.projectId, amendmentId, title: updated.title }));
    } catch { /* never fails the cancellation */ }
    return data;
  }
}

export const projectAmendmentService = new ProjectAmendmentService();
