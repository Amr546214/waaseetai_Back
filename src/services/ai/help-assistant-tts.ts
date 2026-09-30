import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger';
import { mapHelpAssistantRole } from '../../sockets/help-assistant-auth';
import { WaseetAiErrorCode, normalizeWaseetAiError } from './waseet-ai/waseet-ai.errors';
import type { TtsSynthesizeRequest } from './waseet-ai/waseet-ai.types';

// Help Assistant / Bebo text-to-speech — authenticated server-side relay.
//
//   Angular (JWT, REST)  ──POST /api/help-assistant/tts──▶  this handler
//     ──▶ waseetAiClient.synthesizeSpeech (the only holder of the WaseetAI
//         bearer token) ──▶ WaseetAI POST /v1/ai/tts/synthesize
//     ◀── audio/wav bytes (never the upstream JSON, never an upstream error)
//
// Identity comes ONLY from the authenticated request (`req.user`, set by the
// `authenticate` middleware from a verified JWT + live session). Nothing in
// the body is ever treated as identity: only `text`, `voice` and `dialect`
// are read, each strictly validated. The model is fixed server-side.
//
// Allowlists are the exact option lists of the Bebo v4 handoff
// (cute-robot/server.mjs VOICES, bebo-core.mjs DIALECTS); unlike the demo
// proxy (which silently fell back to defaults) an unknown value is rejected.

export const TTS_VOICES = ['Puck', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Sulafat', 'Charon', 'Leda'] as const;
export const TTS_DIALECTS = ['egyptian', 'saudi', 'gulf', 'msa', 'english'] as const;
/** Handoff default ("Flash-Lite · سريع"); the client cannot choose a model. */
export const TTS_MODEL = 'gemini-3.8-flash-lite-tts';
/** Same bound the help gateway already applies to spoken answers. */
export const MAX_TTS_TEXT_LENGTH = 1500;
const TTS_TIMEOUT_MS = 45_000;
const USER_WINDOW_MS = 10 * 60 * 1000;
const USER_MAX_REQUESTS = 20;

export type TtsVoice = (typeof TTS_VOICES)[number];
export type TtsDialect = (typeof TTS_DIALECTS)[number];

export const TTS_MESSAGES = {
	AUTH_REQUIRED: 'يجب تسجيل الدخول بحساب نشط لاستخدام الصوت.',
	FORBIDDEN: 'الصوت غير متاح لهذا الحساب حالياً.',
	INVALID_TEXT: `نص الصوت فارغ أو أطول من المسموح (الحد الأقصى ${MAX_TTS_TEXT_LENGTH} حرفاً).`,
	INVALID_VOICE: 'الصوت المختار غير مدعوم.',
	INVALID_DIALECT: 'اللهجة المختارة غير مدعومة.',
	RATE_LIMITED: 'طلبات صوت كثيرة في وقت قصير. يرجى المحاولة لاحقاً.',
	NOT_CONFIGURED: 'خدمة الصوت غير متاحة حالياً.',
	TIMEOUT: 'انتهت مهلة تجهيز الصوت. يرجى المحاولة مرة أخرى.',
	UNAVAILABLE: 'تعذر تجهيز الصوت حالياً. الإجابة النصية متاحة.',
} as const;

export type TtsErrorCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED' | 'NOT_CONFIGURED' | 'TIMEOUT' | 'UNAVAILABLE';

export interface HelpAssistantTtsDeps {
	client: {
		isConfigured(): boolean;
		synthesizeSpeech(body: TtsSynthesizeRequest, opts?: { signal?: AbortSignal; timeoutMs?: number; requestId?: string }): Promise<Buffer>;
	};
	/** True when the verified user must not use the assistant (e.g. banned). */
	isBlocked(userId: string): Promise<boolean>;
	/** Records one request for `userId`; true once the user is over the limit. */
	isRateLimited(userId: string): boolean;
}

/** In-memory per-user sliding window (same approach as socket-ai-rate-limit). */
export function createUserRateLimiter(max = USER_MAX_REQUESTS, windowMs = USER_WINDOW_MS, now: () => number = Date.now): (userId: string) => boolean {
	const log = new Map<string, number[]>();
	return (userId) => {
		const t = now();
		const recent = (log.get(userId) ?? []).filter((ts) => t - ts < windowMs);
		if (recent.length >= max) {
			log.set(userId, recent);
			return true;
		}
		recent.push(t);
		log.set(userId, recent);
		return false;
	};
}

export type TtsInput = { ok: true; text: string; voice: TtsVoice; dialect: TtsDialect } | { ok: false; message: string };

/** Validates the request body. Only `text`, `voice`, `dialect` are read. */
export function validateTtsInput(body: unknown): TtsInput {
	const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const text = typeof b.text === 'string' ? b.text.trim() : '';
	if (!text || text.length > MAX_TTS_TEXT_LENGTH) return { ok: false, message: TTS_MESSAGES.INVALID_TEXT };
	if (typeof b.voice !== 'string' || !(TTS_VOICES as readonly string[]).includes(b.voice)) return { ok: false, message: TTS_MESSAGES.INVALID_VOICE };
	if (typeof b.dialect !== 'string' || !(TTS_DIALECTS as readonly string[]).includes(b.dialect)) return { ok: false, message: TTS_MESSAGES.INVALID_DIALECT };
	return { ok: true, text, voice: b.voice as TtsVoice, dialect: b.dialect as TtsDialect };
}

function mapFailure(code: WaseetAiErrorCode): { status: number; code: TtsErrorCode; message: string } {
	switch (code) {
		case WaseetAiErrorCode.NOT_CONFIGURED:
			return { status: 503, code: 'NOT_CONFIGURED', message: TTS_MESSAGES.NOT_CONFIGURED };
		case WaseetAiErrorCode.TIMEOUT:
			return { status: 504, code: 'TIMEOUT', message: TTS_MESSAGES.TIMEOUT };
		case WaseetAiErrorCode.RATE_LIMITED:
			return { status: 429, code: 'RATE_LIMITED', message: TTS_MESSAGES.RATE_LIMITED };
		default:
			return { status: 502, code: 'UNAVAILABLE', message: TTS_MESSAGES.UNAVAILABLE };
	}
}

function fail(res: Response, status: number, code: TtsErrorCode, message: string): void {
	if (res.headersSent) return;
	res.status(status).set('Cache-Control', 'no-store').json({ success: false, code, message });
}

export function createHelpAssistantTtsHandler(deps: HelpAssistantTtsDeps) {
	return async (req: Request, res: Response): Promise<void> => {
		// 1. Identity — from the authenticated request only.
		const user = req.user;
		const userId = user?.id;
		if (!user || typeof userId !== 'string' || !userId) return fail(res, 401, 'AUTH_REQUIRED', TTS_MESSAGES.AUTH_REQUIRED);
		const role = mapHelpAssistantRole(user.activeRole as string | undefined, user.accountType as string | undefined);
		if (!role) return fail(res, 403, 'FORBIDDEN', TTS_MESSAGES.FORBIDDEN);
		try {
			if (await deps.isBlocked(userId)) return fail(res, 403, 'FORBIDDEN', TTS_MESSAGES.FORBIDDEN);
		} catch (error: any) {
			logger.warn(`[HelpAssistantTTS] user check failed: ${error?.name ?? 'Error'}`);
			return fail(res, 502, 'UNAVAILABLE', TTS_MESSAGES.UNAVAILABLE);
		}

		// 2. Input.
		const input = validateTtsInput(req.body);
		if (!input.ok) return fail(res, 400, 'INVALID_INPUT', input.message);

		// 3. Per-user limit, then configuration (fail closed, no upstream call).
		if (deps.isRateLimited(userId)) return fail(res, 429, 'RATE_LIMITED', TTS_MESSAGES.RATE_LIMITED);
		if (!deps.client.isConfigured()) return fail(res, 503, 'NOT_CONFIGURED', TTS_MESSAGES.NOT_CONFIGURED);

		// 4. Upstream — cancelled if the browser goes away (stop / logout).
		const controller = new AbortController();
		res.on('close', () => { if (!res.writableEnded) controller.abort(); });
		const requestId = randomUUID();
		const startedAt = Date.now();
		try {
			const wav = await deps.client.synthesizeSpeech(
				{ text: input.text, dialect: input.dialect, voice: input.voice, model: TTS_MODEL, speakingRate: 'normal', mimeType: 'audio/wav' },
				{ signal: controller.signal, timeoutMs: TTS_TIMEOUT_MS, requestId },
			);
			if (controller.signal.aborted) return;
			logger.info(`[HelpAssistantTTS] ok role=${role} chars=${input.text.length} bytes=${wav.length} ms=${Date.now() - startedAt} requestId=${requestId}`);
			res.status(200).set({ 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(wav);
		} catch (error) {
			if (controller.signal.aborted) return;
			// Code/status/requestId only — never the upstream body, headers or token.
			const e = normalizeWaseetAiError(error);
			logger.warn(`[HelpAssistantTTS] failed code=${e.code} status=${e.status ?? '-'} role=${role} requestId=${requestId}`);
			const mapped = mapFailure(e.code);
			fail(res, mapped.status, mapped.code, mapped.message);
		}
	};
}
