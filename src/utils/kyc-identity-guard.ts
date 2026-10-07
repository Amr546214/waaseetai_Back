import { AppError } from './app-error';

// AUD-FND-000045 — once the account is KYC-VERIFIED the identity it was verified against (idNumber, dob) is frozen; changing it needs the
// support / admin flow, not a profile save. "Not provided" ('' / null / undefined) never counts as a change and never erases the stored value.
export const VERIFIED_IDENTITY_LOCKED_MESSAGE = 'لا يمكن تعديل رقم الهوية أو تاريخ الميلاد بعد توثيق حسابك. تواصل مع الدعم لتعديلها.';

const day = (v: unknown): string | null => {
	if (v === null || v === undefined || v === '') return null;
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

type Stored = { idNumber?: string | null; dob?: Date | string | null; kycStatus?: string | null } | null | undefined;
type Incoming = { idNumber?: unknown; dob?: unknown };

export function idNumberChanged(stored: Stored, incoming: Incoming): boolean {
	const next = text(incoming.idNumber);
	return next !== null && next !== (text(stored?.idNumber) ?? null);
}

export function dobChanged(stored: Stored, incoming: Incoming): boolean {
	const next = day(incoming.dob);
	return next !== null && next !== day(stored?.dob);
}

/** Throws 409 (Arabic) when a VERIFIED account tries to change its idNumber or dob. */
export function assertVerifiedIdentityUnchanged(stored: Stored, incoming: Incoming): void {
	if (stored?.kycStatus === 'VERIFIED' && (idNumberChanged(stored, incoming) || dobChanged(stored, incoming))) {
		throw new AppError(VERIFIED_IDENTITY_LOCKED_MESSAGE, 409);
	}
}

/** True when this save really submits a different identity (new/changed idNumber or dob, or a newly uploaded front/back document). */
export function identitySubmissionChanged(stored: Stored, incoming: Incoming, newDocuments: { front?: unknown; back?: unknown }): boolean {
	return idNumberChanged(stored, incoming) || dobChanged(stored, incoming) || Boolean(newDocuments.front) || Boolean(newDocuments.back);
}
