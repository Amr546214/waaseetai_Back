import { Request, Response, NextFunction } from 'express';
import { chatService } from '../services/chat.service';
import { uploadDataUri, uploadMulterFile } from '../utils/cloudinary-storage';

export class ChatController {
  /**
   * Initiate or get an existing conversation for a project and offer
   * Route: POST /api/chat/conversations/initiate
   */
  public async initiateConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req.user as any).userId || (req.user as any).id;
      const conversation = await chatService.initiateConversation(userId, req.body);

      res.status(200).json({
        success: true,
        message: 'تم الوصول إلى غرفة المحادثة والتفاوض بنجاح',
        data: conversation
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetch list of all active conversations for the authenticated user
   * Route: GET /api/chat/conversations
   */
  public async getConversations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req.user as any).userId || (req.user as any).id;
      const conversations = await chatService.getConversations(userId);

      res.status(200).json({
        success: true,
        data: conversations
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get paginated message history for a specific conversation
   * Route: GET /api/chat/conversations/:id/messages
   */
  public async getMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req.user as any).userId || (req.user as any).id;
      const conversationId = req.params.id as string;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

      const messagesData = await chatService.getMessages(conversationId, userId, page, limit);

      res.status(200).json({
        success: true,
        ...messagesData
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handle file, image, or audio recording upload (Returns URL and metadata)
   * Route: POST /api/chat/upload
   */
  public async uploadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { fileData, fileName, fileType, fileSize, audioDuration } = req.body;
      const userId = (req.user as any).userId || (req.user as any).id;
      const stored = req.file
        ? await uploadMulterFile(req.file, `waseetai/chat/${userId}`)
        : typeof fileData === 'string' && fileData.startsWith('data:')
          ? await uploadDataUri(fileData, { folder: `waseetai/chat/${userId}`, fileName: fileName || 'attachment' })
          : null;
      if (!stored) throw new Error('A multipart file or Base64 data URI is required');

      res.status(200).json({
        success: true,
        message: 'تم إرفاق الملف بنجاح',
        data: {
          fileUrl: stored.url,
          fileName: stored.fileName,
          fileSize: stored.bytes || Number(fileSize) || 0,
          audioDuration: audioDuration || null
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const chatController = new ChatController();
export default chatController;
