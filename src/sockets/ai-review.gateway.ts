import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { isMeaningfulProjectTitle } from '../utils/title-validator';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// F1b — live streaming migrated to the shared Gemini foundation.
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

export class AiReviewGateway {
	public register(socket: Socket): void {
		// Event 1: Real-time text suggestion stream based on title
		socket.on('stream_ai_suggest_text', async (payload: { title: string }) => {
			console.log(`[AiReviewGateway] stream_ai_suggest_text from socket ${socket.id} for title: "${payload?.title}"`);
			const mode = 'suggest';
			const userId = (socket as any).userId;
			if (!userId) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي' });
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true } });
			const isProvider = requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY;
			if (!isProvider) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة' });
				return;
			}

			const validation = isMeaningfulProjectTitle(payload?.title);
			if (!validation.valid) {
				socket.emit('ai_text_stream_end', {
					mode,
					message: `⚠️ ${validation.reason || 'اسم المشروع غير مناسب لتوليد وصف ذكي'}`
				});
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				socket.emit('ai_text_stream_end', { mode, message: SOCKET_AI_RATE_LIMIT_MESSAGE });
				return;
			}

			if (!geminiClient.isConfigured()) {
				socket.emit('ai_text_stream_end', { mode, message: 'خدمة الذكاء الاصطناعي غير مهيأة حالياً. لم يتم إنشاء أي نص بديل.' });
				return;
			}

			socket.emit('ai_text_stream_start', { mode });

			const title = payload.title.trim();
			const abortController = new AbortController();
			const onDisconnect = () => abortController.abort();
			socket.once('disconnect', onDisconnect);

			try {
				const stream = geminiClient.generateStream(
					`Generate a professional project description for: "${title}"`,
					{
						systemInstruction: 'You are Waseet AI creative strategy advisor. Generate an impressive, professional, and comprehensive proposal description in Arabic for a service provider based solely on the service title provided. Mention scope, deliverables, quality assurance, and workflow in clear structured paragraphs or bullet points. Respond directly without introductory chatter.',
						temperature: 0.75,
						maxOutputTokens: 600,
						timeoutMs: 30 * 1000,
						signal: abortController.signal
					}
				);

				let emittedAny = false;
				for await (const chunk of stream) {
					if (!chunk) continue;
					emittedAny = true;
					socket.emit('ai_text_stream_chunk', { chunk, mode });
				}

				if (!emittedAny) {
					throw new Error('Gemini stream produced no content');
				}

				socket.emit('ai_text_stream_end', { mode, message: '✨ اكتمل توليد المقترح الذكي بنجاح' });
			} catch (error: any) {
				console.error('[AiReviewGateway] Gemini streaming error on suggest:', error?.code || error?.message);
				// Honest failure — no word-by-word canned-text simulation.
				socket.emit('ai_text_stream_end', { mode, message: 'تعذر توليد النص عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.' });
			} finally {
				socket.off('disconnect', onDisconnect);
			}
		});

		// Event 2: Real-time description enhancement stream
		socket.on('stream_ai_enhance_description', async (payload: { title?: string; description: string }) => {
			console.log(`[AiReviewGateway] stream_ai_enhance_description from socket ${socket.id}`);
			const mode = 'improve';
			const userId = (socket as any).userId;
			if (!userId) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي' });
				return;
			}

			const requester = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true } });
			const isProvider = requester?.accountType === AccountType.PROVIDER_INDIVIDUAL || requester?.accountType === AccountType.PROVIDER_COMPANY;
			if (!isProvider) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ هذه الميزة متاحة فقط لحسابات مقدمي الخدمة' });
				return;
			}

			const title = payload.title?.trim() || '';
			const description = payload.description?.trim() || '';

			if (title) {
				const validation = isMeaningfulProjectTitle(title);
				if (!validation.valid) {
					socket.emit('ai_text_stream_end', {
						mode,
						message: `⚠️ ${validation.reason || 'اسم المشروع غير مناسب للتحسين الذكي'}`
					});
					return;
				}
			}

			if (!description && !title) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ يرجى إضافة اسم المشروع أو وصف مبدئي للتحسين' });
				return;
			}

			if (isSocketAiRateLimited(userId)) {
				socket.emit('ai_text_stream_end', { mode, message: SOCKET_AI_RATE_LIMIT_MESSAGE });
				return;
			}

			if (!geminiClient.isConfigured()) {
				socket.emit('ai_text_stream_end', { mode, message: 'خدمة الذكاء الاصطناعي غير مهيأة حالياً. لم يتم إنشاء أي نص بديل.' });
				return;
			}

			socket.emit('ai_text_stream_start', { mode });

			const abortController = new AbortController();
			const onDisconnect = () => abortController.abort();
			socket.once('disconnect', onDisconnect);

			try {
				const stream = geminiClient.generateStream(
					`Project Title: ${title || 'مشروع عام'}\nCurrent Draft Description: ${description}`,
					{
						systemInstruction: 'You are an expert copywriter and product marketing strategist for Waseet AI platform. Rewrite and drastically improve the user submitted service description into a high-converting, persuasive, professional, and structured Arabic project proposal description. Use clear formatting, bullets, and strong professional industry vocabulary.',
						temperature: 0.7,
						maxOutputTokens: 650,
						timeoutMs: 30 * 1000,
						signal: abortController.signal
					}
				);

				let emittedAny = false;
				for await (const chunk of stream) {
					if (!chunk) continue;
					emittedAny = true;
					socket.emit('ai_text_stream_chunk', { chunk, mode });
				}

				if (!emittedAny) {
					throw new Error('Gemini stream produced no content');
				}

				socket.emit('ai_text_stream_end', { mode, message: '🚀 تم تحسين الوصف باحترافية فائقة' });
			} catch (error: any) {
				console.error('[AiReviewGateway] Gemini streaming error on enhance:', error?.code || error?.message);
				// Honest failure — no word-by-word canned-text simulation.
				socket.emit('ai_text_stream_end', { mode, message: 'تعذر تحسين النص عبر الذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.' });
			} finally {
				socket.off('disconnect', onDisconnect);
			}
		});
	}
}

export const aiReviewGateway = new AiReviewGateway();
export const registerAiReviewGateway = (socket: Socket) => aiReviewGateway.register(socket);
