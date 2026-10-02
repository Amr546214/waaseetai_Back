import { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger';
import { waseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { WaseetAiErrorCode, normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { HelpChatHistoryMessage } from '../services/ai/waseet-ai/waseet-ai.types';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';
import { resolveHelpAssistantUser, type HelpAssistantRole } from './help-assistant-auth';

// Help AI Assistant + dashboard Avatar — ONE real engine for every
// authenticated dashboard role (client / provider / marketer / admin).
//
//   Angular (authenticated socket, JWT in handshake)
//     ──help:ask──▶ this gateway (per-request auth + session + rate limit)
//     ──▶ waseetAiClient.streamHelpChat (the only holder of the WaseetAI
//         bearer token) ──SSE──▶ WaseetAI POST /v1/ai/help/chat
//
// Previously this gateway called Gemini directly with a static in-repo
// knowledge prompt and served guests. It now relays the real WaseetAI help
// stream and requires an authenticated, active, non-revoked session.
//
// Socket contract (existing events preserved; every payload now also
// carries `clientRequestId` so a UI can ignore stale/superseded streams):
//   in : help:ask {question, history?, clientRequestId?}
//   in : help:cancel {clientRequestId}
//   out: help:answer_start {clientRequestId}
//   out: help:answer_chunk {clientRequestId, chunk}
//   out: help:citations {clientRequestId, citations:[{docId,title}]}
//   out: help:answer_complete {clientRequestId}
//   out: help:error {clientRequestId, code, message, humanSupportFallback}
//
// Voice is NOT served over this socket. The legacy `help:audio` OpenAI TTS
// path was removed; assistant speech goes Angular → authenticated
// POST /api/help-assistant/tts (routes/help-assistant-tts.routes.ts) →
// WaseetAI TTS. A client-sent `speak` flag is ignored.
//
// Role handling: WaseetAI's help endpoint has no role field (verified live:
// unknown keys are stripped), so the verified role stays at THIS layer
// (access policy + logs). It is never sent upstream and never invented as
// an upstream field. Nothing else about the user (id, name, email, money)
// is sent upstream either — only the question and a short bounded history.

export const MAX_QUESTION_LENGTH = 500;
const MAX_HISTORY_TURNS = 3;
const MAX_HISTORY_FIELD_LENGTH = 1000;
const STREAM_TIMEOUT_MS = 60_000;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const HELP_MESSAGES = {
	AUTH_REQUIRED: 'يجب تسجيل الدخول بحساب نشط لاستخدام المساعد الذكي. يرجى تسجيل الدخول مجدداً.',
	FORBIDDEN: 'المساعد الذكي غير متاح لهذا الحساب حالياً.',
	EMPTY: 'يرجى كتابة سؤالك أولاً.',
	TOO_LONG: `السؤال طويل جداً (الحد الأقصى ${MAX_QUESTION_LENGTH} حرفاً)، يرجى اختصاره.`,
	NOT_CONFIGURED: 'المساعد الذكي غير متاح حالياً. يمكنك التواصل مع فريق الدعم البشري للمساعدة.',
	NO_ANSWER: 'لم يجد المساعد الذكي إجابة معتمدة لهذا السؤال في قاعدة المعرفة. يمكنك إعادة صياغة سؤالك أو التواصل مع فريق الدعم البشري.',
	TIMEOUT: 'انتهت مهلة انتظار رد المساعد الذكي. يرجى المحاولة مرة أخرى.',
	UNAVAILABLE: 'تعذر الحصول على رد من المساعد الذكي حالياً. يمكنك المحاولة مرة أخرى أو التواصل مع فريق الدعم البشري.',
} as const;

export type HelpErrorCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'NOT_CONFIGURED' | 'NO_ANSWER' | 'TIMEOUT' | 'UNAVAILABLE';

interface LegacyHistoryTurn {
	question: string;
	answer: string;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

/** Accepts the existing frontend history shape ({question, answer}[]) and
 *  converts it to the upstream-validated shape ({role, content}[]). Only a
 *  short, bounded tail survives; malformed/oversized turns are dropped. */
export function toUpstreamHistory(raw: unknown): HelpChatHistoryMessage[] {
	if (!Array.isArray(raw)) return [];
	const out: HelpChatHistoryMessage[] = [];
	for (const item of raw.slice(-MAX_HISTORY_TURNS)) {
		if (!item || typeof item !== 'object') continue;
		const { question, answer } = item as Partial<LegacyHistoryTurn>;
		if (isBoundedString(question, MAX_HISTORY_FIELD_LENGTH) && isBoundedString(answer, MAX_HISTORY_FIELD_LENGTH)) {
			out.push({ role: 'user', content: question.trim() }, { role: 'assistant', content: answer.trim() });
		}
	}
	return out;
}

function mapFailure(error: unknown): { code: HelpErrorCode; message: string } {
	const e = normalizeWaseetAiError(error);
	switch (e.code) {
		case WaseetAiErrorCode.STREAM_ERROR:
			// Only an explicit upstream human_support_fallback flag means "no
			// approved policy answers this" (knowledge-base gap). Any other
			// in-stream error is a service failure and must not be reported to
			// the user as a missing policy.
			return e.humanSupportFallback === true
				? { code: 'NO_ANSWER', message: HELP_MESSAGES.NO_ANSWER }
				: { code: 'UNAVAILABLE', message: HELP_MESSAGES.UNAVAILABLE };
		case WaseetAiErrorCode.TIMEOUT:
			return { code: 'TIMEOUT', message: HELP_MESSAGES.TIMEOUT };
		case WaseetAiErrorCode.NOT_CONFIGURED:
			return { code: 'NOT_CONFIGURED', message: HELP_MESSAGES.NOT_CONFIGURED };
		default:
			return { code: 'UNAVAILABLE', message: HELP_MESSAGES.UNAVAILABLE };
	}
}

export class HelpAssistantChatGateway {
	/** One in-flight help stream per socket; a new question supersedes it. */
	private readonly inFlight = new WeakMap<Socket, { clientRequestId: string; controller: AbortController }>();

	public register(socket: Socket): void {
		socket.on('help:cancel', (payload: { clientRequestId?: unknown }) => {
			const current = this.inFlight.get(socket);
			if (current && payload?.clientRequestId === current.clientRequestId) current.controller.abort();
		});

		socket.on('help:ask', async (payload: { question?: unknown; history?: unknown; clientRequestId?: unknown }) => {
			const clientRequestId =
				typeof payload?.clientRequestId === 'string' && CLIENT_REQUEST_ID_PATTERN.test(payload.clientRequestId) ? payload.clientRequestId : randomUUID();
			const fail = (code: HelpErrorCode, message: string, humanSupportFallback = false) =>
				socket.emit('help:error', { clientRequestId, code, message, humanSupportFallback });

			// 1. Authentication first — nothing else is evaluated for a guest.
			let auth;
			try {
				auth = await resolveHelpAssistantUser(socket);
			} catch (error: any) {
				logger.warn(`[HelpAssistant] auth lookup failed: ${error?.name ?? 'Error'}`);
				fail('UNAVAILABLE', HELP_MESSAGES.UNAVAILABLE, true);
				return;
			}
			if (!auth.ok) {
				fail(auth.reason === 'FORBIDDEN' ? 'FORBIDDEN' : 'AUTH_REQUIRED', auth.reason === 'FORBIDDEN' ? HELP_MESSAGES.FORBIDDEN : HELP_MESSAGES.AUTH_REQUIRED);
				return;
			}

			// 2. Input validation.
			const question = typeof payload?.question === 'string' ? payload.question.trim() : '';
			if (!question) return void fail('INVALID_INPUT', HELP_MESSAGES.EMPTY);
			if (question.length > MAX_QUESTION_LENGTH) return void fail('INVALID_INPUT', HELP_MESSAGES.TOO_LONG);

			// 3. Rate limit per verified user id.
			if (isSocketAiRateLimited(auth.userId)) return void fail('RATE_LIMITED', SOCKET_AI_RATE_LIMIT_MESSAGE);

			// 4. Configuration.
			if (!waseetAiClient.isConfigured()) return void fail('NOT_CONFIGURED', HELP_MESSAGES.NOT_CONFIGURED, true);

			await this.relay(socket, {
				clientRequestId,
				question,
				history: toUpstreamHistory(payload?.history),
				role: auth.role,
			});
		});
	}

	private async relay(
		socket: Socket,
		req: { clientRequestId: string; question: string; history: HelpChatHistoryMessage[]; role: HelpAssistantRole },
	): Promise<void> {
		const { clientRequestId } = req;
		this.inFlight.get(socket)?.controller.abort();
		const controller = new AbortController();
		this.inFlight.set(socket, { clientRequestId, controller });
		const onDisconnect = () => controller.abort();
		socket.once('disconnect', onDisconnect);

		const requestId = randomUUID();
		const startedAt = Date.now();
		let started = false;
		let answer = '';
		const emitStart = () => {
			if (started) return;
			started = true;
			socket.emit('help:answer_start', { clientRequestId });
		};

		try {
			const body = req.history.length ? { question: req.question, history: req.history } : { question: req.question };
			const stream = waseetAiClient.streamHelpChat(body, { signal: controller.signal, timeoutMs: STREAM_TIMEOUT_MS, requestId });

			for await (const evt of stream) {
				if (controller.signal.aborted) break;
				if (evt.type === 'started') emitStart();
				else if (evt.type === 'delta') {
					emitStart();
					answer += evt.chunk;
					// Only ever the plain string chunk — never a raw upstream object.
					socket.emit('help:answer_chunk', { clientRequestId, chunk: evt.chunk });
				} else if (evt.type === 'citations') {
					socket.emit('help:citations', { clientRequestId, citations: evt.citations.map((c) => ({ docId: c.docId, title: c.title })) });
				} else if (evt.type === 'completed') break;
			}

			if (controller.signal.aborted) {
				logger.info(`[HelpAssistant] cancelled role=${req.role} requestId=${requestId}`);
				return;
			}
			if (!answer.trim()) {
				// A "completed" stream with no text is not an answer.
				logger.warn(`[HelpAssistant] empty completed stream role=${req.role} requestId=${requestId}`);
				socket.emit('help:error', { clientRequestId, code: 'UNAVAILABLE', message: HELP_MESSAGES.UNAVAILABLE, humanSupportFallback: true });
				return;
			}

			socket.emit('help:answer_complete', { clientRequestId });
			logger.info(`[HelpAssistant] completed role=${req.role} chars=${answer.length} ms=${Date.now() - startedAt} requestId=${requestId}`);
		} catch (error) {
			// `controller` is only ever aborted by help:cancel, a superseding
			// question, or a disconnect (the client's own timeout uses its own
			// internal controller and surfaces as TIMEOUT below) — in those
			// cases nobody is waiting for an error message.
			if (controller.signal.aborted) {
				logger.info(`[HelpAssistant] aborted role=${req.role} requestId=${requestId}`);
				return;
			}
			const mapped = mapFailure(error);
			const e = normalizeWaseetAiError(error);
			logger.warn(`[HelpAssistant] failed code=${e.code} status=${e.status ?? '-'} role=${req.role} requestId=${requestId}`);
			// Honest failure — never a canned/fabricated answer. Every AI
			// failure offers the human-support path.
			socket.emit('help:error', { clientRequestId, code: mapped.code, message: mapped.message, humanSupportFallback: true });
			return;
		} finally {
			socket.off('disconnect', onDisconnect);
			if (this.inFlight.get(socket)?.controller === controller) this.inFlight.delete(socket);
		}
	}
}

export const helpAssistantChatGateway = new HelpAssistantChatGateway();
export const registerHelpAssistantChatGateway = (socket: Socket) => helpAssistantChatGateway.register(socket);
