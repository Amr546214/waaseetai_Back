import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { prisma } from './config/db';
import OpenAI from 'openai';
import jwt from 'jsonwebtoken';
import { registerProposalAuditGateway } from './sockets/proposal-audit.gateway';
import { registerChatGateway } from './sockets/chat.gateway';
import { registerAiReviewGateway } from './sockets/ai-review.gateway';
import { registerQuizSocketGateway } from './sockets/quiz.socket';
import { registerAiAssistantGateway } from './sockets/ai-assistant.gateway';
import { registerAccreditationAiGateway } from './sockets/accreditation-ai.gateway';
import { registerAssessmentGateway } from './sockets/assessment.gateway';
import { registerSetupTestGateway } from './sockets/setup-test.gateway';

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	timeout: 15 * 1000,
	maxRetries: 0,
});

export let ioInstance: SocketIOServer | null = null;
export const getIO = (): SocketIOServer | null => ioInstance;

export const initSocketServer = (httpServer: HttpServer, allowedOrigins: string[]) => {
	const io = new SocketIOServer(httpServer, {
		cors: {
			origin: allowedOrigins,
			methods: ['GET', 'POST'],
			credentials: true,
		}
	});
	ioInstance = io;

	// Dedicated /assessments Namespace
	const assessmentsNs = io.of('/assessments');
	assessmentsNs.on('connection', (socket) => {
		console.log('🔗 Client connected to /assessments WebSocket namespace:', socket.id);
		registerAssessmentGateway(socket, io);
	});

	io.on('connection', (socket) => {
		console.log('🔗 Client connected to WebSocket:', socket.id);

		// Extract authenticated user ID if token was provided in handshake
		try {
			const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
			if (token && process.env.JWT_SECRET) {
				const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
				if (decoded?.userId || decoded?.id) {
					const verifiedUserId = decoded.userId || decoded.id;
					(socket as any).userId = verifiedUserId;
					socket.join(`project_owner_${verifiedUserId}`);
					socket.join(`user_${verifiedUserId}`);
					console.log(`📡 Socket ${socket.id} authenticated and joined rooms for user ${verifiedUserId}`);
				}
			}
		} catch (err: any) {
			// Handshake auth optional for public pages
		}

		// Allow clients to join targeted user/owner rooms ONLY if token matches requested userId
		socket.on('join_user_room', (data: string | { userId: string; token?: string }) => {
			const targetUserId = typeof data === 'string' ? data : data?.userId;
			const clientToken = typeof data === 'object' ? data?.token : null;

			if (!targetUserId) return;

			// Verify that the socket owns the userId
			const currentUserId = (socket as any).userId;
			if (currentUserId === targetUserId) {
				socket.join(`project_owner_${targetUserId}`);
				socket.join(`user_${targetUserId}`);
				console.log(`📡 Socket ${socket.id} joined rooms for user ${targetUserId}`);
				return;
			}

			// If token provided in event payload, verify it
			if (clientToken && process.env.JWT_SECRET) {
				try {
					const decoded = jwt.verify(clientToken, process.env.JWT_SECRET) as any;
					const tokenUserId = decoded.userId || decoded.id;
					if (tokenUserId === targetUserId) {
						(socket as any).userId = targetUserId;
						socket.join(`project_owner_${targetUserId}`);
						socket.join(`user_${targetUserId}`);
						console.log(`📡 Socket ${socket.id} verified via payload and joined rooms for user ${targetUserId}`);
					}
				} catch (e) {
					console.warn(`⚠️ Socket ${socket.id} unauthorized join_user_room attempt for ${targetUserId}`);
				}
			}
		});

		// Register Proposal AI Review Audit Gateway (Step 3: مراجعة AI)
		registerProposalAuditGateway(socket);

		// Register Real-Time Chat & Negotiation Gateway
		registerChatGateway(socket, io);

		// Register Real-Time AI Review & Text Streaming Gateway
		registerAiReviewGateway(socket);

		// Register Real-Time Specialty Verification Quiz & Anti-Cheat Gateway
		registerQuizSocketGateway(socket, io);

		// Register Real-Time AI Assistant Gateway (Create Request description generator/refiner)
		registerAiAssistantGateway(socket);

		// Register Accreditation AI Gateway (Step 2: AI Vision proof review)
		registerAccreditationAiGateway(socket);

		// Register Real-Time AI Assessment & Multimodal 20-Question Streaming Gateway
		registerAssessmentGateway(socket, io);

		// Register Profile Setup Test Gateway
		registerSetupTestGateway(socket, io);

		socket.on('ai_chat', async (data) => {
			const { message, token, currentRoute } = data;
			let userId = (socket as any).userId || null;

			if (token && !userId && process.env.JWT_SECRET) {
				try {
					const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
					userId = decoded.userId || decoded.id;
				} catch (err) {
					// ignore invalid token
				}
			}

			let systemPrompt = '';
			let fallbackText = 'مرحباً بك في وسيط AI! أنا مساعدك الذكي، كيف يمكنني خدمتك اليوم؟';
			const commonPrompt = `You are the Waseet AI 3D guide. Break your response into chronological segments inside speechTimeline.
        Assign 'bodyLanguagePose' from ["WELCOME_OPEN", "ANALYTICAL_THINKING", "INSTRUCTIVE_DIRECTING", "CELEBRATORY_JUMP", "EMPATHETIC_SOFT"].
        Set 'excitementLevel' and 'gestureFrequency' (0.0 to 1.0) to control the dynamic kinetic engine.`;

			if (userId) {
				const user = await prisma.user.findUnique({ where: { id: userId } });
				if (user) {
					fallbackText = `مرحباً ${user.firstName}، كيف يمكنني مساعدتك اليوم؟`;
					systemPrompt = `أنت مساعد الذكاء الاصطناعي "وسيط AI". \nالمستخدم الحالي مسجل الدخول واسمه: ${user.firstName} ${user.lastName}. \nنوع حسابه: ${user.accountType}.\nيجب أن ترحب به باسمه.\nكن ودوداً، احترافياً، وقدم إجابات مختصرة ومباشرة تتناسب مع كونه ${user.accountType === 'CLIENT_INDIVIDUAL' || user.accountType === 'CLIENT_COMPANY' ? 'طالب خدمة' : 'مقدم خدمة'}.\n\n${commonPrompt}`;
				}
			} else {
				systemPrompt = `أنت مساعد الذكاء الاصطناعي "وسيط AI". \nالمستخدم الحالي هو زائر غير مسجل (Guest).\nمهمتك هي شرح دور منصة وسيط AI بوضوح (منصة عمل حر تضمن حقوق الطرفين).\nشجعه على التسجيل بطريقة مرحبة، احترافية، ومبسطة جداً.\nاستخدم لغة عربية فصحى ومبسطة، وإجابات قصيرة ومباشرة.\n\n${commonPrompt}`;
			}

			let textResponse = fallbackText;
			let speechTimeline = [{ textSegment: fallbackText, animationCue: 'GREETING' }];
			let audioBase64 = null;

			try {
				const chatCompletion = await openai.chat.completions.create({
					model: "gpt-4o-mini",
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: message || "مرحباً" }
					],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "speech_timeline_response",
							strict: true,
							schema: {
								type: "object",
								properties: {
									fullResponse: { type: "string" },
									speechTimeline: {
										type: "array",
										items: {
											type: "object",
											properties: {
												textSegment: { type: "string" },
												excitementLevel: { type: "number" },
												gestureFrequency: { type: "number" },
												bodyLanguagePose: { type: "string", enum: ["WELCOME_OPEN", "ANALYTICAL_THINKING", "INSTRUCTIVE_DIRECTING", "CELEBRATORY_JUMP", "EMPATHETIC_SOFT"] }
											},
											required: ["textSegment", "excitementLevel", "gestureFrequency", "bodyLanguagePose"],
											additionalProperties: false
										}
									}
								},
								required: ["fullResponse", "speechTimeline"],
								additionalProperties: false
							}
						}
					},
					max_tokens: 300,
					temperature: 0.7,
				});

				if (chatCompletion.choices[0].message.content) {
					const parsed = JSON.parse(chatCompletion.choices[0].message.content);
					textResponse = parsed.fullResponse;
					speechTimeline = parsed.speechTimeline;
				}

				const mp3Response = await openai.audio.speech.create({
					model: "tts-1-hd",
					voice: "onyx",
					response_format: "mp3",
					input: textResponse,
				});

				const buffer = Buffer.from(await mp3Response.arrayBuffer());
				audioBase64 = buffer.toString('base64');
			} catch (aiError: any) {
				console.warn('⚠️ OpenAI API Error in WebSocket. Falling back to text-only.', aiError.message);
			}

			// Emit response back to the single connected socket
			socket.emit('ai_chat_response', {
				success: true,
				data: {
					text: textResponse,
					speechTimeline: speechTimeline,
					audioBase64: audioBase64,
				}
			});
		});

		socket.on('disconnect', () => {
			console.log('🔌 Client disconnected:', socket.id);
		});
	});

	return io;
};
