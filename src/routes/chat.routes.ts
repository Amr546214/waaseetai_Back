import { Router } from 'express';
import { chatController } from '../controllers/chat.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { createConversationSchema } from '../dtos/chat.dto';
import { memoryUpload } from '../utils/cloudinary-storage';

const router = Router();

// Initiate or retrieve existing conversation for an offer/project negotiation
router.post(
  '/conversations/initiate',
  authenticate,
  validateDto(createConversationSchema),
  chatController.initiateConversation
);

// Get list of active conversations for authenticated user
router.get(
  '/conversations',
  authenticate,
  chatController.getConversations
);

// Get paginated message thread
router.get(
  '/conversations/:id/messages',
  authenticate,
  chatController.getMessages
);

// Upload file, image, or audio voice note attachment
router.post(
  '/upload',
  authenticate,
  memoryUpload({ fileSize: 25 * 1024 * 1024, files: 1 }).single('file'),
  chatController.uploadAttachment
);

export default router;
