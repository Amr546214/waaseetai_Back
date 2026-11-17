import { createHash } from 'node:crypto';
import { AppError } from '../utils/app-error';

/**
 * ONE IDENTITY, ONE ACCOUNT. An identity (issuing country + document number, normalised) belongs to the first account whose identity an administrator APPROVED
 * (the approval is the only moment a claim is taken: a typed number alone never blocks anybody, so nobody can squat another person's number).
 *  - A later account that submits the same identity is refused at the identity step (assertAvailable) before anything is stored.
 *  - The approval itself takes the claim inside the approval transaction (claim): the unique digest makes two simultaneous approvals impossible.
 *  - A claim is released when the approval is cancelled (rejection, changed evidence, legal-name change) unless the same account still holds an approved identity with that number.
 * Gated by IDENTITY_UNIQUE_ENFORCEMENT=on (needs the identity_claims table, see prisma/migrations/*_identity_claims). With the flag off nothing here touches the database.
 */
export type ClaimParty = 'CLIENT' | 'PROVIDER';
export interface ClaimEvidence { idNumber?: string | null; idIssuingCountry?: string | null }

export const IDENTITY_ALREADY_REGISTERED_MESSAGE = 'هذه الهوية مسجّلة بالفعل بحساب آخر، ولا يمكن استخدام نفس الهوية في أكثر من حساب';
export const IDENTITY_ALREADY_REGISTERED_CODE = 'IDENTITY_ALREADY_REGISTERED';

export const identityUniqueEnforced = (env: NodeJS.ProcessEnv = process.env): boolean => (env.IDENTITY_UNIQUE_ENFORCEMENT ?? '').trim().toLowerCase() === 'on';

/** Letters and digits only, upper-case: «١٢٣ 456-789» and «123456789» are the same number. Arabic-Indic digits are converted. */
export function normalizeIdentityNumber(raw: unknown): string {
  const ascii = String(raw ?? '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  return ascii.replace(/[^\p{L}\p{Nd}]/gu, '').toUpperCase();
}

/** The claim digest: country + number (the document TYPE is left out on purpose, so changing the type never frees a number). null when there is no usable number. */
export function identityClaimDigest(evidence: ClaimEvidence | null | undefined): string | null {
  const number = normalizeIdentityNumber(evidence?.idNumber);
  if (number.length < 5) return null;
  const country = String(evidence?.idIssuingCountry ?? '').trim().toUpperCase();
  return createHash('sha256').update(`waseet-identity-claim:v1|${country}|${number}`).digest('hex');
}

const taken = (claimedByUserId?: string) => new AppError(IDENTITY_ALREADY_REGISTERED_MESSAGE, 409, [{ path: 'idNumber', field: 'idNumber', code: IDENTITY_ALREADY_REGISTERED_CODE, message: IDENTITY_ALREADY_REGISTERED_MESSAGE, ...(claimedByUserId ? { claimedByUserId } : {}) }], IDENTITY_ALREADY_REGISTERED_CODE);

export class IdentityClaimService {
  constructor(private readonly enabled: () => boolean = () => identityUniqueEnforced()) {}

  /** For the account that is submitting its identity: refused when ANOTHER account already holds this identity. Reveals nothing about that account. */
  async assertAvailable(db: any, userId: string, evidence: ClaimEvidence): Promise<void> {
    if (!this.enabled()) return;
    const digest = identityClaimDigest(evidence);
    if (!digest) return;
    const existing = await db.identityClaim.findUnique({ where: { digest }, select: { userId: true } });
    if (existing && existing.userId !== userId) throw taken();
  }

  /** Inside the approval transaction: this account takes the claim. Another holder = the approval is refused (the administrator is told which account holds it). */
  async claim(tx: any, userId: string, party: ClaimParty, evidence: ClaimEvidence): Promise<void> {
    if (!this.enabled()) return;
    const digest = identityClaimDigest(evidence);
    if (!digest) return;
    const existing = await tx.identityClaim.findUnique({ where: { digest }, select: { userId: true } });
    if (existing) { if (existing.userId === userId) return; throw taken(existing.userId); }
    try { await tx.identityClaim.create({ data: { digest, userId, party } }); }
    catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const winner = await tx.identityClaim.findUnique({ where: { digest }, select: { userId: true } });
      if (winner && winner.userId === userId) return;
      throw taken(winner?.userId);
    }
  }

  /** The approval of this party is gone: the account's claims go too, unless its OTHER profile still holds an approved identity with the same number. */
  async release(tx: any, userId: string, party: ClaimParty): Promise<void> {
    if (!this.enabled()) return;
    const claims = await tx.identityClaim.findMany({ where: { userId }, select: { digest: true } });
    if (!claims.length) return;
    const other = party === 'CLIENT' ? tx.providerProfile : tx.clientProfile;
    const rest = await other.findUnique({ where: { userId }, select: { kycStatus: true, idNumber: true, idIssuingCountry: true } });
    const keep = rest?.kycStatus === 'VERIFIED' ? identityClaimDigest(rest) : null;
    const drop = claims.map((c: { digest: string }) => c.digest).filter((d: string) => d !== keep);
    if (drop.length) await tx.identityClaim.deleteMany({ where: { userId, digest: { in: drop } } });
  }
}

export const identityClaimService = new IdentityClaimService();
