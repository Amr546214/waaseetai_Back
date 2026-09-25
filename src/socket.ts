import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { registerProposalAuditGateway } from './sockets/proposal-audit.gateway';
import { registerChatGateway } from './sockets/chat.gateway';
import { registerAiReviewGateway } from './sockets/ai-review.gateway';
import { registerQuizSocketGateway } from './sockets/quiz.socket';
import { registerAiAssistantGateway } from './sockets/ai-assistant.gateway';
import { registerAccreditationAiGateway } from './sockets/accreditation-ai.gateway';
import { registerAssessmentGateway } from './sockets/assessment.gateway';
import { registerSetupTestGateway } from './sockets/setup-test.gateway';
import { registerAvatarChatGateway } from './sockets/avatar-chat.gateway';
import { sessionService } from './services/session.service';

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
	assessmentsNs.use(async (socket, next) => {
		try {
			const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
			const jwtSecret = process.env.JWT_SECRET;
			if (!token || !jwtSecret) return next(new Error('Authentication required'));
			const decoded = jwt.verify(token, jwtSecret) as { userId?: string; id?: string; exp?: number };
			const userId = decoded.userId || decoded.id;
			if (!userId) return next(new Error('Invalid authentication token'));
			const session = await sessionService.validateOrRegister(userId, token, {
				ipAddress: socket.handshake.address,
				userAgent: socket.handshake.headers['user-agent']
			}, decoded.exp ? new Date(decoded.exp * 1000) : undefined);
			if (!session) return next(new Error('Session is revoked or expired'));
			(socket as any).userId = userId;
			next();
		} catch {
			next(new Error('Invalid authentication token'));
		}
	});
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

		// Register 3D Avatar Assistant Chat Gateway (F8-TEXT, Gemini-migrated)
		registerAvatarChatGateway(socket);

		socket.on('disconnect', () => {
			console.log('🔌 Client disconnected:', socket.id);
		});
	});

	return io;
};
