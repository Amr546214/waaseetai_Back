import { Socket, Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { chatService, authorizeConversationForRole, resolveActiveRole } from '../services/chat.service';
import { prisma } from '../config/db';
import { JoinRoomDto, SendMessageDto } from '../dtos/chat.dto';

// NestJS compatible lifecycle interfaces for Express Gateway structure
export interface OnGatewayConnection {
	handleConnection(client: Socket, ...args: any[]): any;
}

export interface OnGatewayDisconnect {
	handleDisconnect(client: Socket): any;
}

// Decorator adapter for NestJS style syntax and compatibility
export function WebSocketGateway(options?: { namespace?: string; cors?: { origin: string | string[] } }) {
	return function <T extends { new(...args: any[]): {} }>(constructor: T) {
		return class extends constructor {
			namespace = options?.namespace || '/chat';
			cors = options?.cors || { origin: '*' };
		};
	};
}

@WebSocketGateway({ namespace: '/chat', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
	private io?: SocketIOServer | null;

	/**
	 * Handle incoming socket connection with JWT authentication parsing
	 */
	public handleConnection(socket: Socket): void {
		try {
			const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
			if (!token) {
				console.warn(`[ChatGateway] Socket ${socket.id} connected without authentication token.`);
				return;
			}
			const jwtSecret = process.env.JWT_SECRET;
			if (!jwtSecret) {
				console.error('[ChatGateway] JWT_SECRET is missing; chat authentication is disabled.');
				return;
			}
			const decoded = jwt.verify(token, jwtSecret) as { userId: string; accountType: string };

			if (decoded?.userId) {
				(socket as any).userId = decoded.userId;
				socket.join(`user_${decoded.userId}`);
				console.log(`🔌 [ChatGateway] User ${decoded.userId} authenticated on socket ${socket.id}`);
			}
		} catch (err: any) {
			console.error(`[ChatGateway] JWT authentication failed for socket ${socket.id}:`, err.message);
		}
	}

	/**
	 * Handle socket disconnection
	 */
	public handleDisconnect(socket: Socket): void {
		const userId = (socket as any).userId;
		if (userId) {
			console.log(`🔌 [ChatGateway] User ${userId} disconnected (Socket ${socket.id})`);
		}
	}

	/**
	 * Registers WebSocket listeners for real-time messaging, voice notes, and typing indicators
	 */
	public register(socket: Socket, io?: SocketIOServer | null): void {
		this.io = io;
		this.handleConnection(socket);

		// Role-aware participant check shared by every conversation-scoped socket
		// event (join, send, typing, read receipts, calls). activeRole is always
		// resolved fresh from the DB here rather than cached at connect time,
		// since a long-lived socket can outlive a role switch made elsewhere.
		const isConversationParticipant = async (conversationId: string): Promise<boolean> => {
			const userId = (socket as any).userId as string | undefined;
			if (!userId || !conversationId) return false;
			const activeRole = await resolveActiveRole(userId);
			return Boolean(await authorizeConversationForRole(conversationId, userId, activeRole));
		};

		socket.on('disconnect', () => {
			this.handleDisconnect(socket);
		});

		// 0. join_user_room: Joins socket to user personal room `user_${userId}` for global notifications
		socket.on('join_user_room', (requested: string | { userId?: string }) => {
			const authenticatedUserId = (socket as any).userId as string | undefined;
			const requestedUserId = typeof requested === 'string' ? requested : requested?.userId;
			if (authenticatedUserId && requestedUserId === authenticatedUserId) {
				socket.join(`user_${authenticatedUserId}`);
			}
		});

		// 1. join_conversation: Joins socket to room `conversation_${id}`
		socket.on('join_conversation', async (data: JoinRoomDto & { userId?: string }) => {
			try {
				if (!data?.conversationId) return;
				const authenticatedUserId = (socket as any).userId as string | undefined;
				if (!authenticatedUserId) {
					socket.emit('chat_error', { message: 'يجب تسجيل الدخول لفتح المحادثة' });
					return;
				}
				if (!(await isConversationParticipant(data.conversationId))) {
					socket.emit('chat_error', { message: 'غير مصرح لك بالوصول إلى هذه المحادثة' });
					return;
				}
				const roomName = `conversation_${data.conversationId}`;
				socket.join(roomName);
				console.log(`💬 Socket ${socket.id} joined conversation room: ${roomName}`);

				// Notify room participants that user is online
				socket.to(roomName).emit('user_online_status', {
					conversationId: data.conversationId,
					userId: authenticatedUserId,
					isOnline: true
				});
			} catch (err) {
				console.error('[ChatGateway] Error in join_conversation:', err);
			}
		});

		// Leave conversation room
		socket.on('leave_conversation', (data: { conversationId: string; userId: string }) => {
			if (data?.conversationId) {
				const authenticatedUserId = (socket as any).userId as string | undefined;
				const roomName = `conversation_${data.conversationId}`;
				socket.leave(roomName);
				socket.to(roomName).emit('user_online_status', {
					conversationId: data.conversationId,
					userId: authenticatedUserId,
					isOnline: false
				});
			}
		});

		// 2. send_message: Persists message via Prisma, emits `new_message` to room, and pushes notification
		socket.on('send_message', async (payload: { senderId: string; data: SendMessageDto }) => {
			try {
				const data = payload?.data;
				const senderId = (socket as any).userId as string | undefined;
				if (!senderId) throw new Error('يجب تسجيل الدخول لإرسال الرسائل');
				if (!data?.conversationId) return;

				// Resolved fresh from the DB — never trust a role the client claims.
				const senderActiveRole = await resolveActiveRole(senderId);

				// Persist message via Prisma
				const result = await chatService.sendMessage(senderId, data, senderActiveRole);
				const roomName = `conversation_${data.conversationId}`;

				// Push notification in database for offline/unread alert
				if (result.recipientId) {
					const notificationText = data.type === 'AUDIO' ? '🎤 أرسل لك رسالة صوتية جديدة'
						: data.type === 'IMAGE' ? '📷 أرسل لك صورة جديدة'
							: data.type === 'FILE' ? `📁 أرسل لك ملفاً: ${data.fileName || 'مرفق'}`
								: (data.content || 'رسالة جديدة في غرفة التفاوض');
					await prisma.notification.create({
						data: {
							userId: result.recipientId,
							title: 'رسالة تفاوض جديدة',
							message: notificationText,
							type: 'CHAT',
							actionUrl: `/dashboard/messages?conversationId=${data.conversationId}`
						}
					}).catch(e => console.error('[ChatGateway] Notification creation err:', e));
				}

				// Attach temporary client deduplication ID if present
				const msgPayload = { ...result.message, tempId: (data as any).tempId, conversationId: data.conversationId };

				// Broadcast strictly to targeted conversation room and recipient user room
				if (io) {
					io.to(roomName).emit('new_message', msgPayload);
					if (result.recipientId) {
						// conversation_list_update carries the message content — only
						// deliver it to the recipient's personal room if this
						// conversation actually belongs to the role they are CURRENTLY
						// using. Otherwise a message from their other role would
						// incorrectly surface in their currently active dashboard.
						const recipientActiveRole = await resolveActiveRole(result.recipientId);
						if (recipientActiveRole === result.recipientRole) {
							io.to(`user_${result.recipientId}`).emit('conversation_list_update', {
								conversationId: data.conversationId,
								lastMsg: msgPayload
							});
						}
					}
				} else {
					socket.to(roomName).emit('new_message', msgPayload);
					socket.emit('new_message', msgPayload);
				}
			} catch (error: any) {
				console.error('[ChatGateway] Error sending message:', error.message);
				socket.emit('chat_error', { message: error.message || 'فشل إرسال الرسالة' });
			}
		});

		// 3. typing_status: Emits real-time "typing..." indicator
		socket.on('typing_status', async (data: { conversationId: string; userId: string; isTyping: boolean; userName?: string }) => {
			if (!data?.conversationId) return;
			const authenticatedUserId = (socket as any).userId as string | undefined;
			if (!authenticatedUserId) return;
			if (!(await isConversationParticipant(data.conversationId))) return;
			const roomName = `conversation_${data.conversationId}`;
			socket.to(roomName).emit('typing_indicator', {
				conversationId: data.conversationId,
				userId: authenticatedUserId,
				userName: data.userName || 'مستخدم',
				isTyping: data.isTyping
			});
		});

		// 4. mark_as_read: Updates message statuses
		socket.on('mark_as_read', async (data: { conversationId: string; userId: string }) => {
			try {
				const authenticatedUserId = (socket as any).userId as string | undefined;
				if (!data?.conversationId || !authenticatedUserId) return;
				const activeRole = await resolveActiveRole(authenticatedUserId);
				if (!(await authorizeConversationForRole(data.conversationId, authenticatedUserId, activeRole))) return;
				await chatService.markAsRead(data.conversationId, authenticatedUserId, activeRole);
				const roomName = `conversation_${data.conversationId}`;
				socket.to(roomName).emit('messages_read', {
					conversationId: data.conversationId,
					readByUserId: authenticatedUserId
				});
			} catch (err) {
				console.error('[ChatGateway] Error in mark_as_read:', err);
			}
		});

		// 5. WebRTC Video Call Signaling Events (Scoped strictly to conversation room)
		socket.on('call_user', async (data: { conversationId: string; callerId: string; callerName: string; offer: any; isVideo?: boolean }) => {
			if (!data?.conversationId || !(await isConversationParticipant(data.conversationId))) return;
			const roomName = `conversation_${data.conversationId}`;
			const userId = (socket as any).userId as string;
			console.log(`📹 [VideoCall] Call initiated by ${userId} in room ${roomName}`);
			socket.to(roomName).emit('incoming_call', { ...data, callerId: userId });
		});

		// Fallback for direct user call signaling
		socket.on('call_direct_user', async (data: { recipientId: string; callerId: string; callerName: string; offer: any; conversationId?: string; isVideo?: boolean }) => {
			if (!data?.recipientId) return;
			if (data.conversationId && !(await isConversationParticipant(data.conversationId))) return;
			const userId = (socket as any).userId as string | undefined;
			if (!userId) return;
			if (io) {
				io.to(`user_${data.recipientId}`).emit('incoming_call', { ...data, callerId: userId });
			}
		});

		socket.on('answer_call', async (data: { conversationId: string; answer: any; responderId: string }) => {
			if (!data?.conversationId || !(await isConversationParticipant(data.conversationId))) return;
			const roomName = `conversation_${data.conversationId}`;
			console.log(`📹 [VideoCall] Call answered in room ${roomName}`);
			socket.to(roomName).emit('call_accepted', { ...data, responderId: (socket as any).userId });
		});

		socket.on('ice_candidate', async (data: { conversationId: string; candidate: any; senderId: string }) => {
			if (!data?.conversationId || !(await isConversationParticipant(data.conversationId))) return;
			const roomName = `conversation_${data.conversationId}`;
			socket.to(roomName).emit('ice_candidate', { ...data, senderId: (socket as any).userId });
		});

		socket.on('end_call', async (data: { conversationId: string; senderId: string }) => {
			if (!data?.conversationId || !(await isConversationParticipant(data.conversationId))) return;
			const roomName = `conversation_${data.conversationId}`;
			console.log(`📹 [VideoCall] Call ended in room ${roomName}`);
			socket.to(roomName).emit('call_ended', { ...data, senderId: (socket as any).userId });
		});
	}
}

export const chatGateway = new ChatGateway();
export const registerChatGateway = (socket: Socket, io?: SocketIOServer | null) => chatGateway.register(socket, io);
