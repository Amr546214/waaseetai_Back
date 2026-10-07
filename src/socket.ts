import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { registerProposalAuditGateway } from './sockets/proposal-audit.gateway';
import { registerChatGateway } from './sockets/chat.gateway';
import { registerAiReviewGateway } from './sockets/ai-review.gateway';
import { registerAiAssistantGateway } from './sockets/ai-assistant.gateway';
import { registerAssessmentGateway } from './sockets/assessment.gateway';
import { registerSetupTestGateway } from './sockets/setup-test.gateway';
import { registerHelpAssistantChatGateway } from './sockets/help-assistant-chat.gateway';
import { socketAuthMiddleware, verifySocketToken } from './utils/socket-auth';
import { setSocketServer } from './utils/socket-registry';

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

	setSocketServer(io);

	// Main namespace: the handshake check is shared by every gateway (chat, ai-review, assistant, assessment, proposal audit, setup test, help assistant).
	io.use(socketAuthMiddleware({
		required: false,
		onAuthenticated: (socket, userId) => { socket.join(`project_owner_${userId}`); socket.join(`user_${userId}`); }
	}));

	// Dedicated /assessments Namespace: an active account is mandatory.
	const assessmentsNs = io.of('/assessments');
	assessmentsNs.use(socketAuthMiddleware({ required: true }));
	assessmentsNs.on('connection', (socket) => {
		console.log('🔗 Client connected to /assessments WebSocket namespace:', socket.id);
		registerAssessmentGateway(socket, io);
	});

	io.on('connection', (socket) => {
		console.log('🔗 Client connected to WebSocket:', socket.id);

		// socket.userId (and the user rooms) were set by the handshake middleware above; anonymous sockets have none.

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

			// If a token is provided in the event payload, it must pass the same active-account check as the handshake
			if (clientToken) {
				void verifySocketToken(clientToken, { ipAddress: socket.handshake?.address }).then((result) => {
					if (result.ok && result.userId === targetUserId) {
						(socket as any).userId = targetUserId;
						socket.data = { ...(socket.data ?? {}), userId: targetUserId };
						socket.join(`project_owner_${targetUserId}`);
						socket.join(`user_${targetUserId}`);
						console.log(`📡 Socket ${socket.id} verified via payload and joined rooms for user ${targetUserId}`);
					} else {
						console.warn(`⚠️ Socket ${socket.id} unauthorized join_user_room attempt for ${targetUserId}`);
					}
				}).catch(() => console.warn(`⚠️ Socket ${socket.id} join_user_room verification failed`));
			}
		});

		// Register Proposal AI Review Audit Gateway (Step 3: مراجعة AI)
		registerProposalAuditGateway(socket);

		// Register Real-Time Chat & Negotiation Gateway
		registerChatGateway(socket, io);

		// Register Real-Time AI Review & Text Streaming Gateway
		registerAiReviewGateway(socket);

		// Register Real-Time AI Assistant Gateway (Create Request description generator/refiner)
		registerAiAssistantGateway(socket);

		// Register Real-Time AI Assessment & Multimodal 20-Question Streaming Gateway
		registerAssessmentGateway(socket, io);

		// Register Profile Setup Test Gateway
		registerSetupTestGateway(socket, io);

		// The legacy guest-reachable `ai_chat` avatar gateway (Gemini + OpenAI TTS)
		// was removed: the dashboard assistant (Bebo avatar) uses only the
		// authenticated help:* gateway below.

		// Register Help AI Assistant Gateway (WaseetAI help stream; every
		// help:ask is re-authenticated — user + session — in the gateway)
		registerHelpAssistantChatGateway(socket);

		socket.on('disconnect', () => {
			console.log('🔌 Client disconnected:', socket.id);
		});
	});

	return io;
};
