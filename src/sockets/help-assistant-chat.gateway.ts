import { Socket } from 'socket.io';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';
import { HELP_ASSISTANT_SYSTEM_PROMPT } from '../knowledge/help-assistant-knowledge';

// Implementation Batch 2, Part A — Help AI Assistant.
//
// This is a NEW feature, distinct from `ai-assistant.gateway.ts` (which
// generates/refines a client-request description, event `ai:generate_description`).
// This gateway answers general product/how-it-works questions, grounded
// only in the curated knowledge in `knowledge/help-assistant-knowledge.ts`.
//
// Soft-auth by design, same pattern as avatar-chat.gateway.ts: the socket
// connects on the main namespace where a JWT is optional (see socket.ts),
// so `(socket as any).userId` may be null for a guest. Guests are still
// served (never hard-rejected) but rate-limited independently, keyed by
// socket.id since they have no stable identity — never trust a
// client-supplied identifier for this key.

const MAX_QUESTION_LENGTH = 500;
const MAX_HISTORY_TURNS = 3;
const MAX_HISTORY_FIELD_LENGTH = 500;

interface HelpChatHistoryTurn {
	question: string;
	answer: string;
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

// Accepts only a short, bounded conversation tail — never an arbitrary large
// history blob. Anything malformed is dropped rather than rejecting the
// whole request, since history is optional context, not the primary input.
function sanitizeHistory(raw: unknown): HelpChatHistoryTurn[] {
	if (!Array.isArray(raw)) return [];
	const turns: HelpChatHistoryTurn[] = [];
	for (const item of raw.slice(-MAX_HISTORY_TURNS)) {
		if (!item || typeof item !== 'object') continue;
		const q = (item as any).question;
		const a = (item as any).answer;
		if (isNonEmptyBoundedString(q, MAX_HISTORY_FIELD_LENGTH) && isNonEmptyBoundedString(a, MAX_HISTORY_FIELD_LENGTH)) {
			turns.push({ question: q.trim(), answer: a.trim() });
		}
	}
	return turns;
}

function buildPrompt(question: string, history: HelpChatHistoryTurn[]): string {
	const lines: string[] = [];
	for (const turn of history) {
		lines.push(`سؤال سابق: ${turn.question}`);
		lines.push(`إجابة سابقة: ${turn.answer}`);
	}
	lines.push(`السؤال الحالي: ${question}`);
	return lines.join('\n');
}

export class HelpAssistantChatGateway {
	public register(socket: Socket): void {
		socket.on('help:ask', async (payload: { question?: string; history?: unknown }) => {
			const rawQuestion = typeof payload?.question === 'string' ? payload.question.trim() : '';

			if (!rawQuestion) {
				socket.emit('help:error', { message: 'يرجى كتابة سؤالك أولاً.' });
				return;
			}
			if (rawQuestion.length > MAX_QUESTION_LENGTH) {
				socket.emit('help:error', { message: `السؤال طويل جداً (الحد الأقصى ${MAX_QUESTION_LENGTH} حرفاً)، يرجى اختصاره.` });
				return;
			}

			const userId: string | null = (socket as any).userId || null;
			// Soft-auth — guests are served, never rejected, but rate-limited
			// independently, keyed by socket.id since they have no stable identity.
			const rateLimitKey = userId || `guest:${socket.id}`;
			if (isSocketAiRateLimited(rateLimitKey)) {
				socket.emit('help:error', { message: SOCKET_AI_RATE_LIMIT_MESSAGE });
				return;
			}

			if (!geminiClient.isConfigured()) {
				socket.emit('help:error', {
					message: 'المساعد الذكي غير متاح حالياً. يمكنك التواصل مع فريق الدعم البشري للمساعدة.',
					humanSupportFallback: true,
				});
				return;
			}

			const history = sanitizeHistory(payload?.history);
			const prompt = buildPrompt(rawQuestion, history);

			// Registered before the Gemini call (there is no DB lookup in this
			// gateway) so a disconnect mid-stream is always honored.
			const abortController = new AbortController();
			const onDisconnect = () => abortController.abort();
			socket.once('disconnect', onDisconnect);

			socket.emit('help:answer_start');

			try {
				const stream = geminiClient.generateStream(prompt, {
					systemInstruction: HELP_ASSISTANT_SYSTEM_PROMPT,
					temperature: 0.4,
					maxOutputTokens: 500,
					timeoutMs: 25 * 1000,
					signal: abortController.signal,
				});

				let emittedAny = false;
				for await (const chunk of stream) {
					if (!chunk) continue;
					emittedAny = true;
					// Only ever emit the plain string chunk — never the raw
					// Gemini SDK stream/response object.
					socket.emit('help:answer_chunk', { chunk });
				}

				if (!emittedAny) {
					throw new Error('Gemini stream produced no content');
				}

				socket.emit('help:answer_complete');
			} catch (error: any) {
				console.error('[HelpAssistantChatGateway] Gemini streaming error:', error?.code || error?.message);
				// Honest failure — no canned/fabricated answer, direct to human support.
				socket.emit('help:error', {
					message: 'تعذر الحصول على رد من المساعد الذكي حالياً. يمكنك التواصل مع فريق الدعم البشري للمساعدة.',
					humanSupportFallback: true,
				});
			} finally {
				socket.off('disconnect', onDisconnect);
			}
		});
	}
}

export const helpAssistantChatGateway = new HelpAssistantChatGateway();
export const registerHelpAssistantChatGateway = (socket: Socket) => helpAssistantChatGateway.register(socket);
