// Advisory AI look at uploaded images / PDFs (support tickets, disputes, client requests, service gallery). Never used for chat.
// Opt-in (ATTACHMENT_AI_SCAN=true). The AI service can only REFUSE explicit sexual / graphic violence / hate-symbol content; contact info and
// ID documents are reported, not refused. If the AI is down, slow or the file is not an image/PDF <= 2MB, the upload is ACCEPTED and reported
// as "not scanned" (fail-open on purpose: an AI outage must not stop support or disputes). The local scan in attachment-scan.ts stays the hard gate.
import { AppError } from '../../utils/app-error';
import { logger } from '../../config/logger';
import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';

export const ATTACHMENT_AI_MAX_BYTES = 2 * 1024 * 1024;
const SCANNABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export type AttachmentAiContext = 'SUPPORT_TICKET' | 'DISPUTE' | 'CLIENT_REQUEST' | 'SERVICE_GALLERY' | 'AVATAR' | 'OTHER';
export type AttachmentAiResult = { scanned: false; reason: 'DISABLED' | 'NOT_SCANNABLE' | 'AI_UNAVAILABLE' } | { scanned: true; status: 'CLEAN' | 'REVIEW'; categories: string[] };

export const attachmentAiScanEnabled = () => process.env.ATTACHMENT_AI_SCAN === 'true';

export async function guardAttachmentWithAi(file: { buffer: Buffer; mimetype: string }, context: AttachmentAiContext, actor?: { userId: string; role: 'client' | 'provider' | 'marketer' | 'admin' | 'system' }): Promise<AttachmentAiResult> {
	if (!attachmentAiScanEnabled()) return { scanned: false, reason: 'DISABLED' };
	const mimeType = String(file.mimetype).toLowerCase().split(';')[0].trim();
	if (!SCANNABLE.has(mimeType) || file.buffer.length > ATTACHMENT_AI_MAX_BYTES) return { scanned: false, reason: 'NOT_SCANNABLE' };
	let verdict;
	try {
		verdict = await waseetAiClient.inspectAttachment({ file: file.buffer.toString('base64'), mimeType, context, ...(actor ? { actor } : {}) }, { timeoutMs: 25_000, ...(actor ? { actor } : {}) });
	} catch (error: any) {
		logger.warn(`[attachment-ai-guard] scan failed (${context}): ${error?.code || error?.name || 'ERROR'} — accepted as not scanned`);
		return { scanned: false, reason: 'AI_UNAVAILABLE' };
	}
	if (verdict.status === 'BLOCK') throw new AppError('هذا الملف يحتوي على محتوى غير مناسب ولا يمكن قبوله.', 422);
	return { scanned: true, status: verdict.status, categories: verdict.categories };
}

/** Scans every file of one upload; throws on the first refused file. */
export async function guardAttachmentsWithAi(files: Array<{ buffer: Buffer; mimetype: string }>, context: AttachmentAiContext, actor?: { userId: string; role: 'client' | 'provider' | 'marketer' | 'admin' | 'system' }) {
	return Promise.all(files.map(file => guardAttachmentWithAi(file, context, actor)));
}
