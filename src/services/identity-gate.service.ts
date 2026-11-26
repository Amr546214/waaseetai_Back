import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/db';
import { approvedIdentityFields } from './identity-inheritance';
import { normalizeIdentityNumber } from './identity-claim.service';
import { AppError } from '../utils/app-error';
import { documentUpdate } from '../utils/identity-document-context';
import { assertKycFileValues } from '../utils/kyc-value-guard';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from '../utils/kyc-identity-guard';
import { storeKycFileIfNeeded } from '../utils/cloudinary-storage';
import { publicKycRejectionReason } from '../utils/provider-kyc-review';
import { notifyAdmins } from './admin-notifications.service';
import { legalNameKey } from '../utils/legal-name';
import { logger } from '../config/logger';
import { identityFieldCheckService, isIdentityAutoCheckEnabled } from './identity-field-check.service';
import { assertDataUriFileAcceptable } from '../utils/provider-file-guard';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { identityClaimService } from './identity-claim.service';

/**
 * Identity gate (client + provider setup). The identity step is APPROVED only when the admin approved the CURRENT image AND the CURRENT identity data: the approval stores a
 * digest of both (identityApprovedDigest) and any later change cancels it. The status is derived from the existing KYC review state; nothing new is queued anywhere.
 * Setup progression also opens on a completed current full field match (IDENTITY_AUTO_CHECK), without changing that KYC status or its review queue.
 */
export type GateParty = 'CLIENT' | 'PROVIDER';
export type GateStatus = 'NOT_SUBMITTED' | 'UNDER_REVIEW' | 'REJECTED' | 'APPROVED';
export interface IdentityGateState {
  status: GateStatus;
  rejectionReason: string | null;
  canAdvance: boolean;
  /** Onboarding progression only. It never grants KYC approval. */
  automaticCheck?: 'MATCHED' | 'CHECKING' | 'NEEDS_REVIEW' | 'NOT_CHECKED';
  /** Inputs needed for automatic comparison; never a request to upload an existing document again. */
  automaticCheckMissing?: string[];
  submittedAt: string | null;
  missing: string[];
  data: { idNumber: string | null; idIssuingCountry: string | null; idDocumentType: string | null; dob: string | null; hasFront: boolean; hasBack: boolean };
}
export const IDENTITY_NOT_APPROVED_MESSAGE = 'لم تكتمل مطابقة بيانات الهوية أو اعتمادها بعد؛ لا يمكن المتابعة قبل التحقق من الصورة والبيانات الحالية';
export const IDENTITY_EVIDENCE_CHANGED_MESSAGE = 'لا يمكن تغيير صورة الهوية أو بياناتها ضمن الإرسال النهائي؛ احفظ التغيير من خطوة الهوية وانتظر اكتمال المطابقة أو المراجعة ثم أرسل';
export const IDENTITY_CHANGED_MESSAGE = 'تغيّرت صورة الهوية أو بياناتها أثناء المراجعة؛ راجع المستند الحالي ثم أعد القرار';

const day = (v: unknown): string | null => { if (!v) return null; const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
type IdentityRow = { frontIdUrl?: string | null; backIdUrl?: string | null; idNumber?: string | null; idIssuingCountry?: string | null; idDocumentType?: string | null; dob?: Date | string | null; /** the account's LEGAL name (users.legalName), when the caller loaded it */ legalName?: string | null };

/**
 * Digest of the evidence the admin reviews: the stored image references (unique per upload) + the identity data + the LEGAL name (the name the document is compared with).
 * An account WITHOUT a legal name (older accounts) digests exactly as before the legal name existed, so an approval given then stays valid for that account; once a name is
 * recorded it is part of the evidence: a changed name no longer matches an approval given for another name (the identity goes back to review).
 */
export function identityDigest(p: IdentityRow | null | undefined): string {
  const name = legalNameKey(p?.legalName);
  const parts: string[] = [p?.frontIdUrl ?? '', p?.backIdUrl ?? '', (p?.idNumber ?? '').trim(), p?.idIssuingCountry ?? '', p?.idDocumentType ?? '', day(p?.dob) ?? '', ...(name ? [`legal-name:${name}`] : [])];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function missingIdentityItems(p: IdentityRow | null | undefined): string[] {
  const out: string[] = [];
  if (!p?.idDocumentType) out.push('idDocumentType');
  if (!p?.idIssuingCountry) out.push('idIssuingCountry');
  if (!(p?.idNumber ?? '').trim()) out.push('idNumber');
  if (!p?.frontIdUrl) out.push('frontId');
  // the back side is optional for every kind: the review relies on the front side
  return out;
}

const lockRow = async (tx: any, party: GateParty, userId: string) => {
  if (typeof tx.$queryRaw !== 'function') return;
  if (party === 'CLIENT') await tx.$queryRaw`SELECT 1 FROM client_profiles WHERE "userId" = ${userId} FOR UPDATE`;
  else await tx.$queryRaw`SELECT 1 FROM provider_profiles WHERE "userId" = ${userId} FOR UPDATE`;
};
/** The account's legal name (private evidence). Read where the identity digest is computed so that an approval is bound to the name it was given for. */
export const legalNameOf = async (db: any, userId: string): Promise<string | null> => (await db.user.findUnique({ where: { id: userId }, select: { legalName: true } }))?.legalName ?? null;
const model = (db: any, party: GateParty) => (party === 'CLIENT' ? db.clientProfile : db.providerProfile);
const SELECT = { idNumber: true, idIssuingCountry: true, idDocumentType: true, dob: true, frontIdUrl: true, backIdUrl: true, kycStatus: true, identityApprovedDigest: true } as const;

export function deriveGateState(p: (IdentityRow & { kycStatus?: string | null; identityApprovedDigest?: string | null; notes?: unknown }) | null | undefined, extra: { clientRejection?: string | null; submittedAt?: Date | null; documentRequestWaiting?: boolean } = {}): IdentityGateState {
  const missing = missingIdentityItems(p);
  const kyc = p?.kycStatus ?? 'UNVERIFIED';
  let status: GateStatus = 'NOT_SUBMITTED';
  let reason: string | null = null;
  if (kyc === 'VERIFIED') status = !p?.identityApprovedDigest || p.identityApprovedDigest === identityDigest(p) ? 'APPROVED' : 'UNDER_REVIEW';
  else if (kyc === 'REJECTED') { status = 'REJECTED'; reason = extra.clientRejection ?? publicKycRejectionReason('REJECTED', p?.notes); }
  else if (kyc === 'PENDING' && p?.frontIdUrl) status = 'UNDER_REVIEW';
  if (status !== 'APPROVED' && extra.documentRequestWaiting) status = 'UNDER_REVIEW';
  return {
    status, rejectionReason: status === 'REJECTED' ? reason : null, canAdvance: status === 'APPROVED', submittedAt: extra.submittedAt?.toISOString() ?? null, missing,
    data: { idNumber: p?.idNumber ?? null, idIssuingCountry: p?.idIssuingCountry ?? null, idDocumentType: p?.idDocumentType ?? null, dob: day(p?.dob), hasFront: !!p?.frontIdUrl, hasBack: !!p?.backIdUrl }
  };
}

const bodySchema = z.object({
  idIssuingCountry: z.string().max(2).nullable().optional(),
  idDocumentType: z.string().max(20).nullable().optional(),
  idNumber: z.string().trim().max(40).nullable().optional(),
  dob: z.string().trim().refine(v => !Number.isNaN(Date.parse(v)) && new Date(v) <= new Date(), 'تاريخ الميلاد غير صحيح').or(z.literal('')).nullable().optional(),
  frontId: z.string().max(15_000_000).nullable().optional(),
  backId: z.string().max(15_000_000).nullable().optional(),
  /** the owner removes the stored back side (it is optional): the file reference is cleared; the data / review rules treat it like any identity change */
  removeBackId: z.boolean().optional()
}).strict();

export class IdentityGateService {
  /**
   * ONE ACCOUNT, ONE IDENTITY: when the OTHER role of the same account already holds an administrator-approved identity, this role takes it as it stands (document, number,
   * birth date, approval digest) instead of asking for a second upload and a second review. Only when this role has no number of its own or the SAME number (a different
   * number is a different document and stays an administrator's decision). A review of this role that is still waiting is closed by the adoption. Never invents an approval.
   */
  async adoptApprovedIdentity(userId: string, party: GateParty): Promise<boolean> {
    try {
      return await prisma.$transaction(async (tx: any) => {
        await lockRow(tx, party, userId);
        const own = await model(tx, party).findUnique({ where: { userId }, select: SELECT });
        if (!own || own.kycStatus === 'VERIFIED') return false;
        const fields: any = await approvedIdentityFields(tx, userId, party);
        if (!fields.identityApprovedDigest) return false;
        const same = normalizeIdentityNumber(own.idNumber) === normalizeIdentityNumber(fields.idNumber);
        if (normalizeIdentityNumber(own.idNumber) && !same) return false;
        await model(tx, party).update({ where: { userId }, data: { ...fields, ...(party === 'PROVIDER' ? { isVerified: true, notes: null } : {}) } });
        if (party === 'CLIENT') await tx.clientOnboarding.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'APPROVED', reviewedAt: new Date() } });
        return true;
      });
    } catch (error) { logger.warn(`[IdentityGate] adopting the approved identity failed (ignored) party=${party} code=${(error as any)?.code ?? 'ERR'}`); return false; }
  }

  async getState(userId: string, party: GateParty, db: any = prisma): Promise<IdentityGateState> {
    if (db === prisma) await this.adoptApprovedIdentity(userId, party);
    const p0 = await model(db, party).findUnique({ where: { userId }, select: party === 'PROVIDER' ? { ...SELECT, notes: true } : SELECT });
    const p = p0 ? { ...p0, legalName: await legalNameOf(db, userId) } : p0;
    let clientRejection: string | null = null; let submittedAt: Date | null = null; let documentRequestWaiting = false;
    if (party === 'CLIENT') {
      const o = await db.clientOnboarding.findUnique({ where: { userId }, select: { rejectionReason: true, createdAt: true, updatedAt: true } });
      clientRejection = o?.rejectionReason ?? null; submittedAt = o?.updatedAt ?? null;
    } else {
      const n = await db.profileModificationRequest.count({ where: { providerId: userId, category: 'DOCUMENTS', fieldName: 'idDocumentUrl', status: 'PENDING_HUMAN_REVIEW' as any } });
      documentRequestWaiting = n > 0;
    }
    const state = deriveGateState(p as any, { clientRejection, submittedAt, documentRequestWaiting });
    if (state.status === 'UNDER_REVIEW' && isIdentityAutoCheckEnabled()) {
      const comparisonMissing = [...state.missing, ...(!p?.legalName?.trim() ? ['legalName'] : []), ...(!p?.dob ? ['dob'] : [])];
      if (comparisonMissing.length) state.automaticCheckMissing = comparisonMissing;
      // This opens setup steps only. KYC status, approval digest and review queues stay unchanged.
      try {
        const match = await identityFieldCheckService.getCurrentMatch(userId, party, db);
        state.automaticCheck = match.state;
        state.canAdvance = state.missing.length === 0 && match.state === 'MATCHED';
        // Old submissions and changed names/data also need a current check, not an admin page visit.
        if (match.state === 'NOT_CHECKED' && db === prisma) identityFieldCheckService.triggerSafe(userId, party);
      } catch (e) {
        state.automaticCheck = 'NEEDS_REVIEW';
        logger.warn(`[IdentityGate] automatic match unavailable party=${party} code=${(e as any)?.code ?? 'ERR'}`);
      }
    }
    return state;
  }

  /** Setup-only progression: current full field match OR existing manual approval. Never grants KYC status. */
  async assertApproved(userId: string, party: GateParty, db: any = prisma, opts: { allowUnderReview?: boolean } = {}): Promise<void> {
    const state = await this.getState(userId, party, db);
    if (state.canAdvance) return;
    // a provider whose document is already SENT (under review) may carry on with the later steps while the admin decides; NOT_SUBMITTED and REJECTED stay closed
    if (opts.allowUnderReview && state.status === 'UNDER_REVIEW') return;
    throw new AppError(IDENTITY_NOT_APPROVED_MESSAGE, 409, [{ path: 'identity', field: 'identity', code: 'IDENTITY_NOT_APPROVED', message: IDENTITY_NOT_APPROVED_MESSAGE, status: state.status, rejectionReason: state.rejectionReason }], 'IDENTITY_NOT_APPROVED');
  }

  /**
   * Gate for a SUBMISSION (a request that carries steps after the identity step): the CURRENT evidence must pass progression (field match or approval) AND the request must not change it
   * (a new image, a different reference, or different identity data). Evaluated BEFORE any write: a refused submission persists nothing and leaves the approval as it was.
   * Echoing the stored references / data unchanged is not a change.
   */
  async assertApprovedForSubmission(userId: string, party: GateParty, incoming: { idNumber?: unknown; idIssuingCountry?: unknown; idDocumentType?: unknown; dob?: unknown; frontId?: unknown; backId?: unknown }, db: any = prisma): Promise<void> {
    await this.assertApproved(userId, party, db, { allowUnderReview: true });
    const stored = await model(db, party).findUnique({ where: { userId }, select: SELECT });
    const differs = (value: unknown, current: string | null | undefined) => typeof value === 'string' && value.trim() !== '' && value !== current;
    const changed = identitySubmissionChanged(stored, incoming, { front: differs(incoming.frontId, stored?.frontIdUrl), back: differs(incoming.backId, stored?.backIdUrl) });
    if (!changed) return;
    throw new AppError(IDENTITY_EVIDENCE_CHANGED_MESSAGE, 409, [{ path: 'identity', field: 'identity', code: 'IDENTITY_NOT_APPROVED', message: IDENTITY_EVIDENCE_CHANGED_MESSAGE, status: 'APPROVED', reason: 'EVIDENCE_CHANGED_IN_SUBMISSION', rejectionReason: null }], 'IDENTITY_NOT_APPROVED');
  }

  /** The approval digest to store when the admin approves (computed on the locked row by the caller); throws 409 when the admin reviewed older evidence. */
  approvalDigest(row: IdentityRow, expected?: string | null): string {
    const current = identityDigest(row);
    if (expected && expected !== current) throw new AppError(IDENTITY_CHANGED_MESSAGE, 409, undefined, 'IDENTITY_CHANGED_SINCE_REVIEW');
    return current;
  }

  /** After ANY write of identity data/images: an APPROVED review whose evidence changed is cancelled (back to PENDING, approval digest cleared). Returns true when it cancelled. */
  async cancelIfChanged(party: GateParty, userId: string, digestBefore: string, db: any = prisma): Promise<boolean> {
    const run = async (tx: any): Promise<boolean> => {
      await lockRow(tx, party, userId);
      const row0 = await model(tx, party).findUnique({ where: { userId }, select: SELECT });
      if (!row0 || row0.kycStatus !== 'VERIFIED') return false;
      const row = { ...row0, legalName: await legalNameOf(tx, userId) };
      if (identityDigest(row) === (row.identityApprovedDigest ?? digestBefore)) return false;
      await model(tx, party).update({ where: { userId }, data: { kycStatus: 'PENDING', identityApprovedDigest: null, ...(party === 'PROVIDER' ? { isVerified: false } : {}) } });
      await identityClaimService.release(tx, userId, party);
      if (party === 'CLIENT' && row.frontIdUrl) await this.refreshClientReview(tx, userId, row.frontIdUrl);
      return true;
    };
    const cancelled = typeof db.$transaction === 'function' ? await db.$transaction(run) : await run(db);
    if (cancelled) void notifyAdmins('KYC_SUBMITTED', { ref: party === 'CLIENT' ? 'عميل' : 'مزود خدمة' });
    return cancelled;
  }

  /** Re-opens the client's review row in the admin queue (PENDING) for the CURRENT front image. */
  async refreshClientReview(tx: any, userId: string, front: string) {
    const fields = { documentType: 'NATIONAL_ID', documentUrl: front, documentName: 'الهوية الوطنية / الإقامة' };
    await tx.clientOnboarding.upsert({ where: { userId }, create: { userId, ...fields, status: 'PENDING' }, update: { ...fields, status: 'PENDING', rejectionReason: null, reviewedAt: null } });
  }

  /** The identity step: saves data + files (kept on rejection) and starts / refreshes / re-opens the review. */
  async saveIdentity(userId: string, party: GateParty, rawBody: unknown): Promise<IdentityGateState> {
    // the other role already holds an approved identity: nothing to upload or review again
    if (await this.adoptApprovedIdentity(userId, party)) return this.getState(userId, party);
    const parsed = bodySchema.safeParse(rawBody ?? {});
    if (!parsed.success) throw new AppError('بيانات الهوية غير صحيحة', 400, parsed.error.issues.map(i => ({ path: i.path.join('.'), field: i.path.join('.'), message: i.message, code: i.code })));
    const body = parsed.data;
    const stored = await model(prisma, party).findUnique({ where: { userId }, select: SELECT });
    const doc = documentUpdate(body, stored);
    // a LEGACY approval (no stored digest) keeps the frozen data rule; a gate approval is cancelled by a change instead
    if (!stored?.identityApprovedDigest) assertVerifiedIdentityUnchanged(stored, body);
    // one identity, one account: refused BEFORE anything is stored when another account already holds this identity (flag IDENTITY_UNIQUE_ENFORCEMENT)
    await identityClaimService.assertAvailable(prisma, userId, { idNumber: body.idNumber || stored?.idNumber, idIssuingCountry: (doc as any)?.idIssuingCountry ?? stored?.idIssuingCountry });
    assertKycFileValues([body.frontId, body.backId], userId, undefined, 'ID_DOCUMENT');
    // an identity picture sent inline (data: URI) skips the upload endpoint: the same AI check runs before anything is stored
    await Promise.all([body.frontId, body.backId].map(v => assertDataUriFileAcceptable(v, 'ID_DOCUMENT', { userId, role: party === 'CLIENT' ? 'client' : 'provider' }, waseetAiClient)));
    const folder = party === 'CLIENT' ? 'clients' : 'providers';
    const [front, back] = await Promise.all([
      storeKycFileIfNeeded(body.frontId, `waseetai/${folder}/${userId}/identity`, 'front-id'),
      storeKycFileIfNeeded(body.backId, `waseetai/${folder}/${userId}/identity`, 'back-id')
    ]);
    const data = { ...doc, ...(body.idNumber ? { idNumber: body.idNumber } : {}), ...(body.dob ? { dob: new Date(body.dob) } : {}), ...(front ? { frontIdUrl: front } : {}), ...(back ? { backIdUrl: back } : body.removeBackId ? { backIdUrl: null } : {}) };
    const started = await prisma.$transaction(async (tx) => {
      await lockRow(tx, party, userId);
      const before = await model(tx, party).findUnique({ where: { userId }, select: SELECT });
      const after = await model(tx, party).upsert({ where: { userId }, create: { userId, ...data }, update: data, select: SELECT });
      const changed = identityDigest(before) !== identityDigest(after);
      const kyc = after.kycStatus as string;
      if (missingIdentityItems(after).length > 0) return false;
      const reopen = kyc === 'UNVERIFIED' || kyc === 'REJECTED' || (kyc === 'VERIFIED' && changed && (!!before?.identityApprovedDigest || !!front || !!back)) || (kyc === 'PENDING' && changed);
      if (!reopen) return false;
      await model(tx, party).update({ where: { userId }, data: { kycStatus: 'PENDING', identityApprovedDigest: null, ...(party === 'PROVIDER' ? { isVerified: false } : {}) } });
      if (kyc === 'VERIFIED') await identityClaimService.release(tx, userId, party);
      if (party === 'CLIENT') await this.refreshClientReview(tx, userId, after.frontIdUrl as string);
      return true; // a new submission (also over a review that was waiting): the administrators are told again
    }, { timeout: 20_000 });
    if (started) void notifyAdmins('KYC_SUBMITTED', { ref: party === 'CLIENT' ? 'عميل' : 'مزود خدمة' });
    // the advisory ID field check for the reviewers (flag IDENTITY_AUTO_CHECK; idempotent per image + data, never blocks or throws)
    identityFieldCheckService.triggerSafe(userId, party);
    return this.getState(userId, party);
  }
}

export const identityGateService = new IdentityGateService();
