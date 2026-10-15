import { Router } from 'express';
import { chatController } from '../controllers/chat.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { createConversationSchema } from '../dtos/chat.dto';
import { memoryUpload } from '../utils/cloudinary-storage';
import { CHAT_UPLOAD_MIME_TYPES } from '../utils/upload-mime-types';

const router = Router();

// Initiate or retrieve existing conversation for an offer/project negotiation
router.post(
  '/conversations/initiate',
  authenticate,
  requireActiveUser,
  validateDto(createConversationSchema),
  chatController.initiateConversation
);

// Get list of active conversations for authenticated user
router.get(
  '/conversations',
  authenticate,
  requireActiveUser,
  chatController.getConversations
);

// Get paginated message thread
router.get(
  '/conversations/:id/messages',
  authenticate,
  requireActiveUser,
  chatController.getMessages
);

// Context of a conversation id (GENERAL | PROJECT) so an old link can redirect to the right place
router.get(
  '/conversations/:id/context',
  authenticate,
  requireActiveUser,
  chatController.getConversationContext
);

// The project's own room: bound to the contract and its two parties, idempotent get-or-create
router.post(
  '/project-rooms/:contractId',
  authenticate,
  requireActiveUser,
  chatController.getProjectRoom
);

router.get(
  '/project-rooms/:contractId/messages',
  authenticate,
  requireActiveUser,
  chatController.getProjectRoomMessages
);

// Upload file, image, or audio voice note attachment
router.post(
  '/upload',
  authenticate,
  requireActiveUser,
  memoryUpload({ fileSize: 25 * 1024 * 1024, files: 1, allowedMimeTypes: CHAT_UPLOAD_MIME_TYPES }).single('file'),
  chatController.uploadAttachment
);

export default router;
