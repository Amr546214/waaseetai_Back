import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { waseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { WaseetAiErrorCode, normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { WaseetAiStreamEvent } from '../services/ai/waseet-ai/waseet-ai.types';
import { isMeaningfulProjectTitle } from '../utils/title-validator';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// AI text streaming (suggest / enhance) runs exclusively through WaseetAI:
//   stream_ai_suggest_text        -> waseetAiClient.streamTextSuggestion({ title })
//   stream_ai_enhance_description -> waseetAiClient.streamTextEnhancement({ description })
// Deltas are relayed as they arrive to the events the Angular client already
// listens to (ai_text_stream_start / ai_text_stream_chunk / ai_text_stream_end).
// The upstream requests accept ONLY `title` / `description`; the enhance
// event's optional `title` (Angular still sends it) is used for the local
// meaningful-title check but is NOT sent upstream. A disconnect aborts the
// upstream stream. Failures are reported honestly (no canned text, no
// fallback); upstream text and credentials are never forwarded.
//
// Security note (Batch: F1+F2 streaming, section 7 review): this gateway
// already gated both events on `(socket as any).userId` (set from the JWT at
// connection time — see socket.ts), so unauthenticated sockets could never
// reach here. What was missing, and is added in this pass, is a per-user
// rate limit: Socket.IO events aren't covered by the HTTP-only `aiLimiter`,
// so previously an authenticated user could emit these events in a tight
// loop with zero throttling. See socket-ai-rate-limit.ts.
//
// Phase 3 Batch 2A fix: the only current UI callers of both events are the
// provider-facing "New Project" wizard (business-models/new-project, under
// the providerGuard-protected provider-overview shell) via
// new-project.service.ts — confirmed by tracing every emit site in the
// frontend. Both handlers now enforce that same role at the socket layer,
// matching the HTTP twin (ai-review module's own routes), which was already
// provider-restricted.

const STREAM_TIMEOUT_MS = 45 * 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;

export const AI_REVIEW_MESSAGES = {
	SUGGEST_DONE: '✨ اكتمل توليد المقترح الذكي بنجاح',
	ENHANCE_DONE: '🚀 تم تحسين الوصف باحترافية فائقة',
	SUGGEST_FAILED: 'تعذر توليد النص عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.',
	ENHANCE_FAILED: 'تعذر تحسين النص عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.',
	NOT_CONFIGURED: 'خدمة الذكاء الاصطناعي غير مهيأة حالياً. لم يتم إنشاء أي نص بديل.',
	TIMEOUT: 'انتهت مهلة انتظار خدمة الذكاء الاصطناعي، يرجى المحاولة مرة أخرى.',
	NEED_DESCRIPTION: '⚠️ يرجى كتابة وصف مبدئي ليتم تحسينه',
	TOO_LONG: '⚠️ النص طويل جداً، يرجى اختصاره',
} as const;

/** Machine-readable reason carried by a FAILED `ai_text_stream_end` (a successful end has no `error`/`code`). */
export const AI_TEXT_STREAM_ERROR_CODES = {
	UNAUTHENTICATED: 'UNAUTHENTICATED',
	FORBIDDEN: 'FORBIDDEN',
	INVALID_INPUT: 'INVALID_INPUT',
	RATE_LIMITED: 'RATE_LIMITED',
	NOT_CONFIGURED: 'NOT_CONFIGURED',
	TIMEOUT: 'TIMEOUT',
	FAILED: 'FAILED',
} as const;
export type AiTextStreamErrorCode = (typeof AI_TEXT_STREAM_ERROR_CODES)[keyof typeof AI_TEXT_STREAM_ERROR_CODES];

/** Ends the stream with an explicit failure (`error: true` + `code`) so the client can tell it from a normal end and keep the user's draft. */
function emitStreamError(socket: Socket, mode: 'suggest' | 'improve', code: AiTextStreamErrorCode, message: string): void {
	socket.emit('ai_text_stream_end', { mode, message, error: true, code });
}

async function relayTextStream(
	socket: Socket,
	mode: 'suggest' | 'improve',
	open: (opts: { signal: AbortSignal; timeoutMs: number }) => AsyncGenerator<WaseetAiStreamEvent, void, void>,
	messages: { done: string; failed: string },
): Promise<void> {
	if (!waseetAiClient.isConfigured()) {
		emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.NOT_CONFIGURED, AI_REVIEW_MESSAGES.NOT_CONFIGURED);
		return;
	}

	socket.emit('ai_text_stream_start', { mode });

	const abortController = new AbortController();
	const onDisconnect = () => abortController.abort();
	socket.once('disconnect', onDisconnect);

	try {
		let emittedAny = false;
		let completed = false;
		for await (const evt of open({ signal: abortController.signal, timeoutMs: STREAM_TIMEOUT_MS })) {
			if (abortController.signal.aborted) break;
			if (evt.type === 'delta') {
				if (!evt.chunk) continue;
				emittedAny = true;
				// Relayed immediately; only the plain string chunk, never a raw upstream object.
				socket.emit('ai_text_stream_chunk', { chunk: evt.chunk, mode });
			} else if (evt.type === 'completed') {
				completed = true;
				break;
			}
		}

		// Client went away: nobody is listening, emit nothing more.
		if (abortController.signal.aborted) return;

		if (!completed || !emittedAny) {
			logger.warn(`[AiReviewGateway] ${mode} stream ended without usable content`);
			emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FAILED, messages.failed);
			return;
		}
		socket.emit('ai_text_stream_end', { mode, message: messages.done });
	} catch (error) {
		if (abortController.signal.aborted) return;
		const e = normalizeWaseetAiError(error);
		logger.warn(`[AiReviewGateway] ${mode} stream failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
		const [code, message]: [AiTextStreamErrorCode, string] =
			e.code === WaseetAiErrorCode.TIMEOUT ? [AI_TEXT_STREAM_ERROR_CODES.TIMEOUT, AI_REVIEW_MESSAGES.TIMEOUT]
			: e.code === WaseetAiErrorCode.NOT_CONFIGURED ? [AI_TEXT_STREAM_ERROR_CODES.NOT_CONFIGURED, AI_REVIEW_MESSAGES.NOT_CONFIGURED]
			: [AI_TEXT_STREAM_ERROR_CODES.FAILED, messages.failed];
		emitStreamError(socket, mode, code, message);
	} finally {
		socket.off('disconnect', onDisconnect);
	}
}

export class AiReviewGateway {
	public register(socket: Socket): void {
		// Event 1: Real-time text suggestion stream based on title
		socket.on('stream_ai_suggest_text', async (payload: { title: string }) => {
			console.log(`[AiReviewGateway] stream_ai_suggest_text from socket ${socket.id} for title: "${payload?.title}"`);
			const mode = 'suggest';
			const userId = (socket as any).userId;
			if (!userId) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.UNAUTHENTICATED, '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي');
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true } });
			const isProvider = requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY;
			if (!isProvider) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FORBIDDEN, '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة');
				return;
			}

			const validation = isMeaningfulProjectTitle(payload?.title);
			if (!validation.valid) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, `⚠️ ${validation.reason || 'اسم المشروع غير مناسب لتوليد وصف ذكي'}`);
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.RATE_LIMITED, SOCKET_AI_RATE_LIMIT_MESSAGE);
				return;
			}

			const title = payload.title.trim();
			if (title.length > MAX_TITLE_LENGTH) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.TOO_LONG);
				return;
			}

			await relayTextStream(
				socket,
				mode,
				(opts) => waseetAiClient.streamTextSuggestion({ title }, opts),
				{ done: AI_REVIEW_MESSAGES.SUGGEST_DONE, failed: AI_REVIEW_MESSAGES.SUGGEST_FAILED },
			);
		});

		// Event 2: Real-time description enhancement stream
		socket.on('stream_ai_enhance_description', async (payload: { title?: string; description?: string }) => {
			console.log(`[AiReviewGateway] stream_ai_enhance_description from socket ${socket.id}`);
			const mode = 'improve';
			const userId = (socket as any).userId;
			if (!userId) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.UNAUTHENTICATED, '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي');
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true } });
			const isProvider = requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY;
			if (!isProvider) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FORBIDDEN, '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة');
				return;
			}

			const title = payload?.title?.trim() || '';
			const description = payload?.description?.trim() || '';

			if (title) {
				const validation = isMeaningfulProjectTitle(title);
				if (!validation.valid) {
					emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, `⚠️ ${validation.reason || 'اسم المشروع غير مناسب للتحسين الذكي'}`);
					return;
				}
			}

			// The enhance endpoint needs the description itself; a title alone
			// cannot be enhanced (and is never sent upstream).
			if (!description) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.NEED_DESCRIPTION);
				return;
			}
			if (description.length > MAX_DESCRIPTION_LENGTH) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.TOO_LONG);
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.RATE_LIMITED, SOCKET_AI_RATE_LIMIT_MESSAGE);
				return;
			}

			await relayTextStream(
				socket,
				mode,
				(opts) => waseetAiClient.streamTextEnhancement({ description }, opts),
				{ done: AI_REVIEW_MESSAGES.ENHANCE_DONE, failed: AI_REVIEW_MESSAGES.ENHANCE_FAILED },
			);
		});
	}
}

export const aiReviewGateway = new AiReviewGateway();
export const registerAiReviewGateway = (socket: Socket) => aiReviewGateway.register(socket);
