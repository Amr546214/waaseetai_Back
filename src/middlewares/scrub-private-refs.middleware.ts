import { Request, Response, NextFunction } from 'express';
import { isPrivateRef } from '../utils/kyc-private-ref';

// Defence in depth for the KYC private-document design: NO JSON response may carry a raw `private:…` reference. Every such value is replaced
// with null and, next to it, `<field>Access: { private: true }` tells the client a document exists and must be fetched through
// POST /api/kyc-documents/access-link. Legacy (public-URL) KYC values stay as they are for the transition, flagged `legacy: true`.
// A handler that must return a reference to its caller (the upload response) sets res.locals.allowPrivateRef = true.

const LEGACY_KYC_KEYS = new Set(['frontIdUrl', 'backIdUrl', 'supportingDocsUrl', 'idDocumentUrl', 'vatCertificateUrl', 'documentUrl', 'kycDocumentUrl', 'certUrls', 'certificatesUrl']);
const MAX_DEPTH = 10;

function scrub(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return isPrivateRef(value) ? null : value;
	if (value instanceof Date) return value;
	if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) {
		if (typeof child === 'string' && isPrivateRef(child)) {
			out[key] = null;
			out[`${key}Access`] = { private: true, legacy: false };
		} else if (Array.isArray(child) && child.some(isPrivateRef)) {
			out[key] = child.map(item => (isPrivateRef(item) ? null : scrub(item, depth + 1)));
			out[`${key}Access`] = child.map(item => (isPrivateRef(item) ? { private: true, legacy: false } : item ? { private: false, legacy: true } : null));
		} else {
			out[key] = scrub(child, depth + 1);
			if (typeof child === 'string' && child && LEGACY_KYC_KEYS.has(key)) out[`${key}Access`] = { private: false, legacy: true };
		}
	}
	return out;
}

export function scrubPrivateRefs(_req: Request, res: Response, next: NextFunction) {
	const originalJson = res.json.bind(res);
	res.json = ((body?: unknown) => (res.locals.allowPrivateRef ? originalJson(body) : originalJson(scrub(body)))) as Response['json'];
	next();
}

export const __scrubForTest = scrub;
