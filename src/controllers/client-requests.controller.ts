import { Request, Response, NextFunction } from 'express';
import { clientRequestsService } from '../services/client-requests.service';
import { createClientRequestSchema, clientRequestAiSuggestSchema } from '../dtos/create-client-request.dto';
import { AppError } from '../utils/app-error';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { projectProgressService } from '../services/project-progress.service';

export class ClientRequestsController {
  
  // GET /api/client/requests/meta
  public async getMeta(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await clientRequestsService.getMeta();
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/ai-suggest
  public async aiSuggest(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = clientRequestAiSuggestSchema.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues.map(i => i.message).join(', ');
        throw new AppError(errorMsg, 400);
      }

      const userId = req.user!.userId || req.user!.id;
      const result = await clientRequestsService.generateAiSuggest(userId, parsed.data);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests
  public async createRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createClientRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues.map(i => i.message).join(', ');
        throw new AppError(errorMsg, 400);
      }

      const userId = req.user!.userId || req.user!.id;
      const result = await clientRequestsService.createRequest(userId, parsed.data);

      res.status(201).json({
        success: true,
        message: 'تم نشر طلبك بنجاح! جاري توجيهه لأفضل مقدمي الخدمات المعتمدين',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/upload
  public async uploadAttachments(req: Request, res: Response, next: NextFunction) {
    try {
      const files = req.files as Express.Multer.File[] || [];
      if (!files || files.length === 0) {
        throw new AppError('لم يتم رفع أي ملفات', 400);
      }

      const storedFiles = await Promise.all(files.map(file => uploadMulterFile(file, `waseetai/client-requests/${req.user!.id}`)));
      const uploadedFiles = storedFiles.map(file => ({
        fileName: file.fileName,
        fileUrl: file.url,
        mimeType: file.mimeType,
        size: file.bytes
      }));

      res.status(200).json({
        success: true,
        data: uploadedFiles,
        urls: uploadedFiles.map(f => f.fileUrl)
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/client/requests/my-requests or /api/client/my-requests
  public async getMyRequests(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const result = await clientRequestsService.getMyRequests(userId);
      res.status(200).json({
        success: true,
        filters: result.filters,
        data: result.data
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/client/requests/active-projects
  public async getActiveProjects(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const result = await clientRequestsService.getActiveProjects(userId);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/client/my-requests/completed-projects
  public async getCompletedProjects(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const result = await clientRequestsService.getCompletedProjects(userId, page, limit);
      res.status(200).json({
        success: true,
        message: 'تم جلب المشاريع المنتهية بنجاح',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/client/requests/active-projects/:id
  public async getActiveProjectTracking(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const { id } = req.params;
      const result = await clientRequestsService.getActiveProjectTracking(userId, id as string);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  public async getProjectWorkspace(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectProgressService.getProjectProgress(userId, req.params.id as string);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // GET /api/client/my-requests/pending-deliveries
  public async getPendingReviewDeliveries(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectProgressService.getPendingReviewDeliveries(userId);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  public async reviewStageDelivery(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectProgressService.reviewDelivery(userId, req.params.id as string, req.params.stageId as string, req.body?.decision, req.body?.note);
      res.status(200).json({ success: true, message: req.body?.decision === 'approve' ? 'تم اعتماد المرحلة' : 'تم إرسال ملاحظات التعديل', data });
    } catch (error) { next(error); }
  }

  // POST /api/client/requests/:id/stages/:stageId/ai-review
  // Advisory-only — never approves/rejects the delivery, never touches
  // status or escrow. On any Gemini failure this returns an honest 502, not
  // a fabricated review; the manual approve/revision workflow above
  // (reviewStageDelivery) is completely unaffected either way.
  public async getDeliveryAiReview(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectProgressService.getDeliveryAiReview(userId, req.params.id as string, req.params.stageId as string);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      if (error instanceof AppError) return next(error);
      console.error('[DeliveryAiReview] Failed:', error?.code || error?.message);
      res.status(502).json({
        success: false,
        message: 'تعذر إنشاء المراجعة الاستشارية بالذكاء الاصطناعي حالياً. يمكنك متابعة مراجعة التسليم واتخاذ القرار يدوياً كالمعتاد.'
      });
    }
  }

  // Batch 8 — advisory-only Gemini project health analysis (Contract
  // Monitoring / Project Health / Predictive Delay Risk / Predictive
  // Dispute Risk — one real feature). Read-only, never
  // approves/rejects/releases funds/changes status.
  public async getProjectHealthAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectProgressService.getProjectHealthAnalysis(userId, req.params.id as string);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      if (error instanceof AppError) return next(error);
      console.error('[ProjectHealthAnalysis] Failed:', error?.code || error?.message);
      res.status(502).json({
        success: false,
        message: 'تعذر إجراء تحليل صحة المشروع بالذكاء الاصطناعي حالياً. يمكنك متابعة المشروع كالمعتاد.'
      });
    }
  }

  // GET /api/client/requests/:id or GET /api/client/my-requests/:id
  public async getRequestDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const requestId = req.params.id as string;

      const result = await clientRequestsService.getRequestDetails(userId, requestId);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/:id/contract/sign
  public async selectOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const requestId = req.params.id as string;
      const { offerId } = req.body;
      if (!offerId || typeof offerId !== 'string') throw new AppError('offerId is required', 400);
      const result = await clientRequestsService.selectOffer(userId, requestId, offerId);
      res.status(200).json({ success: true, message: 'تم اختيار العرض وتجهيز العقد للتوقيع', data: result });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/:id/contract/sign
  public async signContract(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const requestId = req.params.id as string;
      const { offerId } = req.body;

      if (!offerId) {
        throw new AppError('offerId is required', 400);
      }

      const result = await clientRequestsService.signContract(userId, requestId, offerId);

      res.status(200).json({
        success: true,
        message: 'تم إنشاء كود التحقق وإرساله إلى البريد الإلكتروني',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/:id/escrow/deposit
  public async depositEscrow(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const requestId = req.params.id as string;
      const { offerId, otpCode, paymentMethod } = req.body;

      if (!offerId || !otpCode) {
        throw new AppError('offerId and otpCode are required', 400);
      }

      const result = await clientRequestsService.depositEscrow(userId, requestId, offerId, otpCode, paymentMethod);

      res.status(200).json({
        success: true,
        message: 'تم الإيداع بنجاح وتحويل حالة المشروع',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
}

export const clientRequestsController = new ClientRequestsController();
