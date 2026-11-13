import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { documentUpdate } from '../utils/identity-document-context';
import { assertKycFileValues } from '../utils/kyc-value-guard';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from '../utils/kyc-identity-guard';
import { storeKycFileIfNeeded } from '../utils/cloudinary-storage';
import { publicKycRejectionReason } from '../utils/provider-kyc-review';
import { notifyAdmins } from './admin-notifications.service';
import { legalNameKey } from '../utils/legal-name';

/**
 * Identity gate (client + provider setup). The identity step is APPROVED only when the admin approved the CURRENT image AND the CURRENT identity data: the approval stores a
 * digest of both (identityApprovedDigest) and any later change cancels it. The status is derived from the existing KYC review state; nothing new is queued anywhere.
 */
export type GateParty = 'CLIENT' | 'PROVIDER';
export type GateStatus = 'NOT_SUBMITTED' | 'UNDER_REVIEW' | 'REJECTED' | 'APPROVED';
export interface IdentityGateState {
  status: GateStatus;
  rejectionReason: string | null;
  canAdvance: boolean;
  submittedAt: string | null;
  missing: string[];
  data: { idNumber: string | null; idIssuingCountry: string | null; idDocumentType: string | null; dob: string | null; hasFront: boolean; hasBack: boolean };
}
export const IDENTITY_NOT_APPROVED_MESSAGE = 'وثيقة الهوية لم تُعتمد بعد؛ لا يمكن المتابعة قبل اعتماد صورة الهوية وبياناتها الحالية';
export const IDENTITY_EVIDENCE_CHANGED_MESSAGE = 'لا يمكن تغيير صورة الهوية أو بياناتها ضمن الإرسال النهائي؛ احفظ التغيير من خطوة الهوية وانتظر اعتماده ثم أرسل';
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
  if (!p?.backIdUrl && p?.idDocumentType !== 'PASSPORT') out.push('backId');
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
  backId: z.string().max(15_000_000).nullable().optional()
}).strict();

export class IdentityGateService {
  async getState(userId: string, party: GateParty, db: any = prisma): Promise<IdentityGateState> {
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
    return deriveGateState(p as any, { clientRejection, submittedAt, documentRequestWaiting });
  }

  /** 409 IDENTITY_NOT_APPROVED unless the CURRENT image + data are approved. */
  async assertApproved(userId: string, party: GateParty, db: any = prisma): Promise<void> {
    const state = await this.getState(userId, party, db);
    if (state.canAdvance) return;
    throw new AppError(IDENTITY_NOT_APPROVED_MESSAGE, 409, [{ path: 'identity', field: 'identity', code: 'IDENTITY_NOT_APPROVED', message: IDENTITY_NOT_APPROVED_MESSAGE, status: state.status, rejectionReason: state.rejectionReason }], 'IDENTITY_NOT_APPROVED');
  }

  /**
   * Gate for a SUBMISSION (a request that carries steps after the identity step): the CURRENT evidence must be approved AND the request must not change it
   * (a new image, a different reference, or different identity data). Evaluated BEFORE any write: a refused submission persists nothing and leaves the approval as it was.
   * Echoing the stored references / data unchanged is not a change.
   */
  async assertApprovedForSubmission(userId: string, party: GateParty, incoming: { idNumber?: unknown; idIssuingCountry?: unknown; idDocumentType?: unknown; dob?: unknown; frontId?: unknown; backId?: unknown }, db: any = prisma): Promise<void> {
    await this.assertApproved(userId, party, db);
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
    const parsed = bodySchema.safeParse(rawBody ?? {});
    if (!parsed.success) throw new AppError('بيانات الهوية غير صحيحة', 400, parsed.error.issues.map(i => ({ path: i.path.join('.'), field: i.path.join('.'), message: i.message, code: i.code })));
    const body = parsed.data;
    const stored = await model(prisma, party).findUnique({ where: { userId }, select: SELECT });
    const doc = documentUpdate(body, stored);
    // a LEGACY approval (no stored digest) keeps the frozen data rule; a gate approval is cancelled by a change instead
    if (!stored?.identityApprovedDigest) assertVerifiedIdentityUnchanged(stored, body);
    assertKycFileValues([body.frontId, body.backId], userId);
    const folder = party === 'CLIENT' ? 'clients' : 'providers';
    const [front, back] = await Promise.all([
      storeKycFileIfNeeded(body.frontId, `waseetai/${folder}/${userId}/identity`, 'front-id'),
      storeKycFileIfNeeded(body.backId, `waseetai/${folder}/${userId}/identity`, 'back-id')
    ]);
    const data = { ...doc, ...(body.idNumber ? { idNumber: body.idNumber } : {}), ...(body.dob ? { dob: new Date(body.dob) } : {}), ...(front ? { frontIdUrl: front } : {}), ...(back ? { backIdUrl: back } : {}) };
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
      if (party === 'CLIENT') await this.refreshClientReview(tx, userId, after.frontIdUrl as string);
      return kyc !== 'PENDING';
    }, { timeout: 20_000 });
    if (started) void notifyAdmins('KYC_SUBMITTED', { ref: party === 'CLIENT' ? 'عميل' : 'مزود خدمة' });
    return this.getState(userId, party);
  }
}

export const identityGateService = new IdentityGateService();
