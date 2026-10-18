import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { waseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { WaseetAiErrorCode, normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { WaseetAiStreamEvent } from '../services/ai/waseet-ai/waseet-ai.types';
import { isMeaningfulProjectTitle } from '../utils/title-validator';
import { AI_DESCRIPTION_MAX_CHARS, AI_DESCRIPTION_RAW_MAX_CHARS, SEED_FACTS_MARKER, buildDescriptionCandidates } from '../utils/ai-description-candidates';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// AI text streaming (suggest / enhance) is a WaseetAI-linked feature and stays on WaseetAI (it does not use the internal LlmClient):
//   stream_ai_suggest_text        -> waseetAiClient.streamTextSuggestion({ title })
//   stream_ai_enhance_description -> waseetAiClient.streamTextEnhancement({ description })
// G1: the vendor prompt cannot receive our field limit, so the finished reply is validated HERE (utils/ai-description-candidates.ts) before it is
// announced as complete: split into discrete candidates (introduction/advice dropped), each <= 1500 UTF-16 units (cut only at a complete sentence),
// or an honest error (OUTPUT_TOO_LONG / EMPTY_OUTPUT) with nothing approvable. Every event echoes the page's `requestId`; a new request or
// `ai_text_stream_cancel` aborts the previous stream of the same socket, which then emits nothing more.
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
	OUTPUT_TOO_LONG: `تجاوز الاقتراح الحد المسموح (${AI_DESCRIPTION_MAX_CHARS} حرفاً) ولم نجد صياغة مكتملة ضمن الحد. لم يُعتمد أي نص، حاول مرة أخرى.`,
	EMPTY_OUTPUT: 'لم تُرجع خدمة الذكاء الاصطناعي وصفاً صالحاً. حاول مرة أخرى.',
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
	OUTPUT_TOO_LONG: 'OUTPUT_TOO_LONG',
	EMPTY_OUTPUT: 'EMPTY_OUTPUT',
} as const;
export type AiTextStreamErrorCode = (typeof AI_TEXT_STREAM_ERROR_CODES)[keyof typeof AI_TEXT_STREAM_ERROR_CODES];

/** Ends the stream with an explicit failure (`error: true` + `code`) so the client can tell it from a normal end and keep the user's draft. */
function emitStreamError(socket: Socket, mode: 'suggest' | 'improve', code: AiTextStreamErrorCode, message: string, requestId?: string): void {
	socket.emit('ai_text_stream_end', { mode, message, error: true, code, ...(requestId ? { requestId } : {}) });
}

/** The client's correlation id for one AI request; every event of that request echoes it so the page can ignore stale events. */
export function readRequestId(payload: any): string | undefined {
	const id = payload?.requestId;
	return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** One live AI stream per socket: a new request (or an explicit cancel) aborts the previous one, which then emits nothing more. */
interface ActiveStream { controller: AbortController | null; requestId?: string }

async function relayTextStream(
	socket: Socket,
	mode: 'suggest' | 'improve',
	open: (opts: { signal: AbortSignal; timeoutMs: number }) => AsyncGenerator<WaseetAiStreamEvent, void, void>,
	messages: { done: string; failed: string },
	requestId: string | undefined,
	active: ActiveStream,
	seed?: string,
): Promise<void> {
	const rid = requestId ? { requestId } : {};
	if (!waseetAiClient.isConfigured()) {
		emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.NOT_CONFIGURED, AI_REVIEW_MESSAGES.NOT_CONFIGURED, requestId);
		return;
	}

	const abortController = new AbortController();
	active.controller?.abort();
	active.controller = abortController;
	active.requestId = requestId;
	const onDisconnect = () => abortController.abort();
	socket.once('disconnect', onDisconnect);

	socket.emit('ai_text_stream_start', { mode, ...rid });

	try {
		let emittedAny = false;
		let completed = false;
		let raw = '';
		for await (const evt of open({ signal: abortController.signal, timeoutMs: STREAM_TIMEOUT_MS })) {
			if (abortController.signal.aborted) break;
			if (evt.type === 'delta') {
				if (!evt.chunk) continue;
				emittedAny = true;
				raw += evt.chunk;
				if (raw.length > AI_DESCRIPTION_RAW_MAX_CHARS) {
					abortController.abort();
					emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.OUTPUT_TOO_LONG, AI_REVIEW_MESSAGES.OUTPUT_TOO_LONG, requestId);
					return;
				}
				// Relayed immediately so the page can show the live text in its suggestions area (never in the field);
				// only the plain string chunk, never a raw upstream object.
				socket.emit('ai_text_stream_chunk', { chunk: evt.chunk, mode, ...rid });
			} else if (evt.type === 'completed') {
				completed = true;
				break;
			}
		}

		// Client went away or the request was superseded/cancelled: nobody is listening, emit nothing more.
		if (abortController.signal.aborted) return;

		if (!completed || !emittedAny) {
			logger.warn(`[AiReviewGateway] ${mode} stream ended without usable content`);
			emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FAILED, messages.failed, requestId);
			return;
		}

		// The result the user can approve is validated HERE, before it is announced as complete: discrete candidates, none over the limit.
		const { candidates, rejectedTooLong } = buildDescriptionCandidates(raw, AI_DESCRIPTION_MAX_CHARS, seed);
		if (!candidates.length) {
			logger.warn(`[AiReviewGateway] ${mode} reply rejected: no candidate within ${AI_DESCRIPTION_MAX_CHARS} chars (rawLength=${raw.length}, tooLong=${rejectedTooLong})`);
			emitStreamError(
				socket, mode,
				rejectedTooLong > 0 ? AI_TEXT_STREAM_ERROR_CODES.OUTPUT_TOO_LONG : AI_TEXT_STREAM_ERROR_CODES.EMPTY_OUTPUT,
				rejectedTooLong > 0 ? AI_REVIEW_MESSAGES.OUTPUT_TOO_LONG : AI_REVIEW_MESSAGES.EMPTY_OUTPUT,
				requestId,
			);
			return;
		}
		socket.emit('ai_text_stream_end', { mode, message: messages.done, candidates, limit: AI_DESCRIPTION_MAX_CHARS, ...(seed ? { fromContext: true } : {}), ...rid });
	} catch (error) {
		if (abortController.signal.aborted) return;
		const e = normalizeWaseetAiError(error);
		logger.warn(`[AiReviewGateway] ${mode} stream failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
		const [code, message]: [AiTextStreamErrorCode, string] =
			e.code === WaseetAiErrorCode.TIMEOUT ? [AI_TEXT_STREAM_ERROR_CODES.TIMEOUT, AI_REVIEW_MESSAGES.TIMEOUT]
			: e.code === WaseetAiErrorCode.NOT_CONFIGURED ? [AI_TEXT_STREAM_ERROR_CODES.NOT_CONFIGURED, AI_REVIEW_MESSAGES.NOT_CONFIGURED]
			: [AI_TEXT_STREAM_ERROR_CODES.FAILED, messages.failed];
		emitStreamError(socket, mode, code, message, requestId);
	} finally {
		socket.off('disconnect', onDisconnect);
		if (active.controller === abortController) { active.controller = null; active.requestId = undefined; }
	}
}

export class AiReviewGateway {
	public register(socket: Socket): void {
		const active: ActiveStream = { controller: null };
		// The page cancels the running stream on retry/navigation: it stops, and nothing more is emitted for it.
		socket.on('ai_text_stream_cancel', (payload?: { requestId?: string }) => {
			const id = readRequestId(payload);
			if (active.controller && (!id || !active.requestId || id === active.requestId)) active.controller.abort();
		});
		// Event 1: Real-time text suggestion stream based on title
		socket.on('stream_ai_suggest_text', async (payload: { title: string }) => {
			console.log(`[AiReviewGateway] stream_ai_suggest_text from socket ${socket.id} for title: "${payload?.title}"`);
			const mode = 'suggest';
			const requestId = readRequestId(payload);
			const userId = (socket as any).userId;
			if (!userId) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.UNAUTHENTICATED, '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي', requestId);
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, activeRole: true } });
			const isAdminAccount = requester?.accountType === AccountType.ADMIN || requester?.accountType === AccountType.SUPER_ADMIN;
			const isProvider =
				!isAdminAccount &&
				(requester?.activeRole === 'PROVIDER' ||
					(!requester?.activeRole && (requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY)));
			if (!isProvider) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FORBIDDEN, '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة', requestId);
				return;
			}

			const validation = isMeaningfulProjectTitle(payload?.title);
			if (!validation.valid) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, `⚠️ ${validation.reason || 'اسم المشروع غير مناسب لتوليد وصف ذكي'}`, requestId);
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.RATE_LIMITED, SOCKET_AI_RATE_LIMIT_MESSAGE, requestId);
				return;
			}

			const title = payload.title.trim();
			if (title.length > MAX_TITLE_LENGTH) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.TOO_LONG, requestId);
				return;
			}

			await relayTextStream(
				socket,
				mode,
				(opts) => waseetAiClient.streamTextSuggestion({ title }, opts),
				{ done: AI_REVIEW_MESSAGES.SUGGEST_DONE, failed: AI_REVIEW_MESSAGES.SUGGEST_FAILED },
				requestId,
				active,
			);
		});

		// Event 2: Real-time description enhancement stream
		socket.on('stream_ai_enhance_description', async (payload: { title?: string; description?: string; seeded?: boolean }) => {
			console.log(`[AiReviewGateway] stream_ai_enhance_description from socket ${socket.id}`);
			const mode = 'improve';
			const requestId = readRequestId(payload);
			const userId = (socket as any).userId;
			if (!userId) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.UNAUTHENTICATED, '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي', requestId);
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, activeRole: true } });
			const isAdminAccount = requester?.accountType === AccountType.ADMIN || requester?.accountType === AccountType.SUPER_ADMIN;
			const isProvider =
				!isAdminAccount &&
				(requester?.activeRole === 'PROVIDER' ||
					(!requester?.activeRole && (requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY)));
			if (!isProvider) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.FORBIDDEN, '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة', requestId);
				return;
			}

			const title = payload?.title?.trim() || '';
			const description = payload?.description?.trim() || '';

			if (title) {
				const validation = isMeaningfulProjectTitle(title);
				if (!validation.valid) {
					emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, `⚠️ ${validation.reason || 'اسم المشروع غير مناسب للتحسين الذكي'}`, requestId);
					return;
				}
			}

			// The enhance endpoint needs the description itself; a title alone
			// cannot be enhanced (and is never sent upstream).
			if (!description) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.NEED_DESCRIPTION, requestId);
				return;
			}
			if (description.length > MAX_DESCRIPTION_LENGTH) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.INVALID_INPUT, AI_REVIEW_MESSAGES.TOO_LONG, requestId);
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				emitStreamError(socket, mode, AI_TEXT_STREAM_ERROR_CODES.RATE_LIMITED, SOCKET_AI_RATE_LIMIT_MESSAGE, requestId);
				return;
			}

			await relayTextStream(
				socket,
				mode,
				(opts) => waseetAiClient.streamTextEnhancement({ description }, opts),
				{ done: AI_REVIEW_MESSAGES.ENHANCE_DONE, failed: AI_REVIEW_MESSAGES.ENHANCE_FAILED },
				requestId,
				active,
				// A seeded request (empty-field generation) is checked against the seed's facts; the seed itself is never relayed or stored.
				payload?.seeded === true && description.includes(SEED_FACTS_MARKER) ? description : undefined,
			);
		});
	}
}

export const aiReviewGateway = new AiReviewGateway();
export const registerAiReviewGateway = (socket: Socket) => aiReviewGateway.register(socket);
