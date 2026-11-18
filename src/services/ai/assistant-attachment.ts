// The assistant's file attachment: the browser uploads ONE file, the server checks it and reads it ONCE into short text; only that text (never the
// file) travels with the next question. Nothing is stored. Order: type allow-list + magic bytes -> local safety scan -> AI safety look (opt-in,
// fail-open, refuses explicit/violent/hate content) -> AI read (text of a text/PDF, or a description of a picture).
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/app-error';
import { assertAttachmentSafe } from '../../utils/attachment-scan';
import { contentMatchesDeclaredType, looksLikeMarkup } from '../../utils/file-signature';
import { guardAttachmentWithAi } from '../ai-features/attachment-ai-guard';
import { waseetAiClient } from './waseet-ai/waseet-ai.client';

export const ASSISTANT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const ASSISTANT_ATTACHMENT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json']);
export const ASSISTANT_ATTACHMENT_MAX_COUNT = 2;
export const ASSISTANT_ATTACHMENT_TEXT_MAX = 4000;

export interface AssistantAttachmentResult { name: string; kind: 'TEXT' | 'IMAGE'; text: string; truncated: boolean; readable: boolean; scanned: boolean }
type Reader = { readAttachment(body: any, opts?: any): Promise<{ kind: 'TEXT' | 'IMAGE'; text: string; truncated: boolean; readable: boolean }> };

const cleanName = (value: string) => String(value || 'file').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120);

export async function readAssistantAttachment(file: { buffer: Buffer; mimetype: string; originalname: string }, actor: { userId: string; role: 'client' | 'provider' | 'marketer' | 'admin' | 'system' }, reader: Reader = waseetAiClient as unknown as Reader): Promise<AssistantAttachmentResult> {
	const mime = String(file.mimetype).toLowerCase().split(';')[0].trim();
	if (!ASSISTANT_ATTACHMENT_MIME.has(mime)) throw new AppError('نوع الملف غير مدعوم هنا. المتاح: صور (PNG/JPG/WEBP) وPDF وملفات نصية.', 415);
	if (!file.buffer.length || file.buffer.length > ASSISTANT_ATTACHMENT_MAX_BYTES) throw new AppError('حجم الملف يجب أن يكون أقل من 2 ميجابايت.', 400);
	if (!contentMatchesDeclaredType(file.buffer, mime)) throw new AppError('محتوى الملف لا يطابق نوعه المعلن.', 400);
	if (mime.startsWith('text/') || mime === 'application/json') { if (file.buffer.includes(0) || looksLikeMarkup(file.buffer)) throw new AppError('الملف النصي غير صالح.', 400); }
	assertAttachmentSafe(file.buffer);
	const ai = await guardAttachmentWithAi({ buffer: file.buffer, mimetype: mime }, 'OTHER', actor); // 422 on explicit / violent / hate content
	let read;
	try {
		read = await reader.readAttachment({ file: file.buffer.toString('base64'), mimeType: mime, name: cleanName(file.originalname), actor }, { actor, timeoutMs: 45_000 });
	} catch {
		throw new AppError('تعذّرت قراءة الملف حالياً. حاول مرة أخرى أو اكتب المحتوى في الرسالة.', 503);
	}
	return { name: cleanName(file.originalname), kind: read.kind, text: String(read.text || '').slice(0, ASSISTANT_ATTACHMENT_TEXT_MAX), truncated: !!read.truncated, readable: !!read.readable, scanned: ai.scanned };
}

export function createAssistantAttachmentHandler(reader?: Reader) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!req.file) throw new AppError('اختر ملفاً', 400);
			const role = (req.user?.activeRole || 'client') as string;
			const actorRole = (['client', 'provider', 'marketer', 'admin'].includes(role.toLowerCase()) ? role.toLowerCase() : 'client') as 'client' | 'provider' | 'marketer' | 'admin';
			const data = await readAssistantAttachment(req.file, { userId: req.user!.id, role: actorRole }, reader);
			res.status(200).json({ success: true, data });
		} catch (error) { next(error); }
	};
}
