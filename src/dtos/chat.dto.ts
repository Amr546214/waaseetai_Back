import { z } from 'zod';
import { MessageType } from '@prisma/client';

export const createConversationSchema = z.object({
  projectId: z.string().min(1, 'معرّف المشروع مطلوب'),
  providerId: z.string().optional(),
  clientId: z.string().optional(),
  offerId: z.string().optional(),
  negotiationPayload: z.object({
    isNegotiation: z.boolean().optional(),
    negType: z.string().optional(),
    negTypeName: z.string().optional(),
    price: z.string().optional(),
    duration: z.string().optional(),
    notes: z.string().optional(),
    status: z.string().optional()
  }).optional()
});

export const sendMessageSchema = z.object({
  conversationId: z.string().min(1, 'معرّف المحادثة مطلوب'),
  tempId: z.string().optional(),
  content: z.string().optional(),
  type: z.nativeEnum(MessageType).optional().default('TEXT'),
  fileUrl: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  audioDuration: z.number().optional(),
  duration: z.number().optional(),
  context: z.any().optional()
});

export const joinRoomSchema = z.object({
  conversationId: z.string().min(1, 'معرّف المحادثة مطلوب')
});

export type CreateConversationDto = z.infer<typeof createConversationSchema>;
export type SendMessageDto = z.infer<typeof sendMessageSchema>;
export type JoinRoomDto = z.infer<typeof joinRoomSchema>;
