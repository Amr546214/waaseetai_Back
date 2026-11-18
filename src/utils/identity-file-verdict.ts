import type { WaseetActor } from '../services/ai/waseet-ai/waseet-ai.auth';
import type { IdentityInspectResponse } from '../services/ai/waseet-ai/waseet-ai.types';

export interface IdentityFileVerdict { verdict: 'OK' | 'REFUSED' | 'UNVERIFIED'; messageAr: string }

type Inspector = { isConfigured(): boolean; inspectIdentityDocument(body: any, opts?: any): Promise<IdentityInspectResponse> };

const READABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
/** a document the AI can read: up to ~7.5 MB (the inspect endpoint takes a data URI of at most 10.5M characters) */
export const IDENTITY_FILE_AI_MAX_BYTES = 7_500_000;

/**
 * The AI looks at an identity document BEFORE it is stored: a picture that is not an identity document or cannot be read is REFUSED (the caller answers 422 and stores nothing).
 * Anything the AI cannot judge (unsupported type, too large, AI down or not configured) is UNVERIFIED and never a refusal: the human review decides.
 * Only «is it an identity document / readable» is enforced here (no field comparison: the marketer flow has no declared name or number).
 */
export async function inspectIdentityFile(file: { buffer: Buffer; mimetype: string }, actor: WaseetActor, client: Inspector): Promise<IdentityFileVerdict> {
	const unverified = (): IdentityFileVerdict => ({ verdict: 'UNVERIFIED', messageAr: 'تعذّر الفحص الآلي للوثيقة؛ ستراجعها الإدارة.' });
	if (!READABLE.has(file.mimetype) || file.buffer.length > IDENTITY_FILE_AI_MAX_BYTES || !client.isConfigured()) return unverified();
	try {
		const r = await client.inspectIdentityDocument(
			{ side: 'FRONT', image: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, imageMimeType: file.mimetype as any },
			{ actor, timeoutMs: 35_000 }
		);
		const refused = r.isIdentityDocument === false || r.status === 'NOT_ID_DOCUMENT' || r.status === 'UNREADABLE' || r.readability === 'UNREADABLE';
		if (!refused) return { verdict: 'OK', messageAr: r.summaryAr || '' };
		const reasons = [r.summaryAr, ...(Array.isArray(r.warningsAr) ? r.warningsAr : [])].filter((s): s is string => typeof s === 'string' && !!s.trim());
		return { verdict: 'REFUSED', messageAr: [...new Set(reasons)].join(' — ') || 'الصورة المرفوعة ليست وثيقة هوية مقروءة.' };
	} catch { return unverified(); }
}
