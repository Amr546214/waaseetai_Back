import { Socket } from 'socket.io';
import OpenAI from 'openai';
import { isMeaningfulProjectTitle } from '../utils/title-validator';

export class AiReviewGateway {
	private openai: OpenAI | null = null;

	constructor() {
		if (process.env.OPENAI_API_KEY) {
			this.openai = new OpenAI({
				apiKey: process.env.OPENAI_API_KEY,
				timeout: 30 * 1000,
				maxRetries: 1
			});
		}
	}

	public register(socket: Socket): void {
		// Event 1: Real-time text suggestion stream based on title
		socket.on('stream_ai_suggest_text', async (payload: { title: string }) => {
			console.log(`[AiReviewGateway] stream_ai_suggest_text from socket ${socket.id} for title: "${payload?.title}"`);
			const mode = 'suggest';
			if (!(socket as any).userId) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي' });
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

			socket.emit('ai_text_stream_start', { mode });

			const title = payload.title.trim();

			// Try OpenAI Streaming via SDK
			if (this.openai) {
				try {
					const stream = await this.openai.chat.completions.create({
						model: 'gpt-4o-mini',
						messages: [
							{
								role: 'system',
								content: 'You are Waseet AI creative strategy advisor. Generate an impressive, professional, and comprehensive proposal description in Arabic for a service provider based solely on the service title provided. Mention scope, deliverables, quality assurance, and workflow in clear structured paragraphs or bullet points. Respond directly without introductory chatter.'
							},
							{
								role: 'user',
								content: `Generate a professional project description for: "${title}"`
							}
						],
						temperature: 0.75,
						max_tokens: 600,
						stream: true,
					});

					for await (const chunk of stream) {
						const token = chunk.choices[0]?.delta?.content || '';
						if (token) {
							socket.emit('ai_text_stream_chunk', { chunk: token, mode });
						}
					}

					socket.emit('ai_text_stream_end', { mode, message: '✨ اكتمل توليد المقترح الذكي بنجاح' });
					return;
				} catch (error: any) {
					console.error('[AiReviewGateway] OpenAI streaming error on suggest, falling back to simulated live typing:', error.message);
				}
			}

			// High-converting fallback with word-by-word typewriter simulation
			const fallbackText = `أقدم لكم خدمة "${title}" باحترافية تامة وفي أعلى معايير الجودة الفنية، مبنية على تحليل عميق لاحتياجات مشروعكم وأهدافكم التنظيمية.\n\n✦ لماذا تختار هذا العرض؟\n- التزام تام بالجدول الزمني وتسليم المخرجات بدقة في المواعيد المحددة.\n- تطبيق أحدث التقنيات والمعايير الهندسية لضمان أداء فائق ومخرجات مستدامة.\n- تقسيم العمل على مراحل تشغيلية واضحة تشمل العرض الأولي، النقاش، والتعديلات المرنة حتى الاعتماد التام.\n- تسليم كامل لحزمة المخرجات وملفات المصدر الأصلية الجاهزة للاستخدام الفوري مع ضمان دعم فني مجاني.`;
			await this.simulateWordByWordStreaming(socket, fallbackText, mode);
		});

		// Event 2: Real-time description enhancement stream
		socket.on('stream_ai_enhance_description', async (payload: { title?: string; description: string }) => {
			console.log(`[AiReviewGateway] stream_ai_enhance_description from socket ${socket.id}`);
			const mode = 'improve';
			if (!(socket as any).userId) {
				socket.emit('ai_text_stream_end', { mode, message: '⚠️ يجب تسجيل الدخول لاستخدام المساعد الذكي' });
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

			socket.emit('ai_text_stream_start', { mode });

			if (this.openai) {
				try {
					const stream = await this.openai.chat.completions.create({
						model: 'gpt-4o-mini',
						messages: [
							{
								role: 'system',
								content: 'You are an expert copywriter and product marketing strategist for Waseet AI platform. Rewrite and drastically improve the user submitted service description into a high-converting, persuasive, professional, and structured Arabic project proposal description. Use clear formatting, bullets, and strong professional industry vocabulary.'
							},
							{
								role: 'user',
								content: `Project Title: ${title || 'مشروع عام'}\nCurrent Draft Description: ${description}`
							}
						],
						temperature: 0.7,
						max_tokens: 650,
						stream: true,
					});

					for await (const chunk of stream) {
						const token = chunk.choices[0]?.delta?.content || '';
						if (token) {
							socket.emit('ai_text_stream_chunk', { chunk: token, mode });
						}
					}

					socket.emit('ai_text_stream_end', { mode, message: '🚀 تم تحسين الوصف باحترافية فائقة' });
					return;
				} catch (error: any) {
					console.error('[AiReviewGateway] OpenAI streaming error on enhance, falling back to simulated live typing:', error.message);
				}
			}

			// High-converting enhancement fallback with word-by-word typewriter simulation
			const baseDesc = description || `عرض تنفيذ مشروع: ${title || 'مشروع متخصص'}`;
			const fallbackEnhanced = `${baseDesc}\n\n✦ القيمة المضافة والمعايير المعتمدة في وسيط AI:\n- تنفيذ منهجي مدروس يعتمد على استراتيجيات التطوير الحديثة لضمان التفاني والإتقان.\n- هيكلية تسليم مرحلية تضمن الشفافية التامة وتمكين العميل من مراجعة وتقييم كل خطوة فنية.\n- تسليم حزمة متكاملة تتضمن الملفات النهائية، وثائق العمل، مع التزام كامل بالمراجعات حتى الوصول إلى النتيجة المثبتة التي تلبي كافة تطلعاتكم.`;
			await this.simulateWordByWordStreaming(socket, fallbackEnhanced, mode);
		});
	}

	/**
	 * Simulates word-by-word streaming across WebSocket to deliver an authentic real-time typing effect
	 */
	private async simulateWordByWordStreaming(socket: Socket, fullText: string, mode: string): Promise<void> {
		const words = fullText.split(/(\s+)/);
		for (const word of words) {
			if (!word) continue;
			socket.emit('ai_text_stream_chunk', { chunk: word, mode });
			await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 35) + 30));
		}
		socket.emit('ai_text_stream_end', { mode, message: '✨ تم إنجاز البث الذكي بنجاح' });
	}
}

export const aiReviewGateway = new AiReviewGateway();
export const registerAiReviewGateway = (socket: Socket) => aiReviewGateway.register(socket);
