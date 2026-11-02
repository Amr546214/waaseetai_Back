import { Request, Response, NextFunction } from 'express';
import { clientRequestsService } from '../services/client-requests.service';
import { clientOfferCounterService } from '../services/client-offer-counter.service';
import { createClientRequestSchema, clientRequestAiSuggestSchema } from '../dtos/create-client-request.dto';
import { AppError } from '../utils/app-error';
import { canRewrite, REWRITE_INPUT_REQUIRED_MESSAGE } from '../utils/description-rewrite-guard';
import { checkMultipleContentPolicy } from '../utils/content-policy-guard';
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

      const title = parsed.data.title?.trim() ?? '';
      const desc = parsed.data.description?.trim() ?? '';
      const specName = parsed.data.specialtyName?.trim() ?? '';

      const policy = checkMultipleContentPolicy([title, desc, specName]);
      if (policy.blocked) {
        throw new AppError(policy.reasonAr || 'المحتوى المدخل يخالف سياسات منصة وسيط.', 400);
      }

      if (parsed.data.fullDraft) {
        if (title.length < 3 && desc.length < 5 && !specName) {
          throw new AppError('يرجى كتابة عنوان مبدئي للطلب أو اختيار التخصص أولاً لتوليد الطلب بالذكاء الاصطناعي.', 400);
        }
      } else if (!canRewrite(title, desc)) {
        throw new AppError(REWRITE_INPUT_REQUIRED_MESSAGE, 400);
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
        // every refusal names its field (errors[]), the summary keeps the old joined text
        const fields = parsed.error.issues.map(i => ({ field: String(i.path[0] ?? ''), path: i.path.join('.'), message: i.message })).filter(f => f.field);
        throw new AppError(errorMsg, 400, fields, 'REQUEST_VALIDATION_FAILED');
      }

      const policy = checkMultipleContentPolicy([parsed.data.title, parsed.data.description, parsed.data.outputs]);
      if (policy.blocked) {
        throw new AppError(policy.reasonAr || 'المحتوى المدخل يخالف سياسات منصة وسيط.', 400);
      }

      const userId = req.user!.userId || req.user!.id;
      const result = await clientRequestsService.createRequest(userId, parsed.data);

      // the same request sent again (double tap / retry after a lost answer) returns the request that already exists: 200, no second copy
      if ((result as { deduplicated?: boolean }).deduplicated) {
        res.status(200).json({ success: true, deduplicated: true, message: 'طلبك منشور بالفعل، فلم ننشئ نسخة ثانية منه.', data: result });
        return;
      }
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
      const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
      const result = await clientRequestsService.getActiveProjects(userId, employeeId);
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
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
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

  // GET /api/client/requests/:id/offers/:offerId/counter
  public async getOfferCounter(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await clientOfferCounterService.getView(userId, req.params.id as string, req.params.offerId as string);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/:id/offers/:offerId/counter/accept  { messageId }
  public async acceptOfferCounter(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await clientOfferCounterService.accept(userId, req.params.id as string, req.params.offerId as string, req.body || {});
      res.status(200).json({ success: true, message: 'تم قبول العرض المضاد، وأصبحت شروطه هي شروط العرض', data });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/client/requests/:id/offers/:offerId/counter/decline  { messageId }
  public async declineOfferCounter(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await clientOfferCounterService.decline(userId, req.params.id as string, req.params.offerId as string, req.body || {});
      res.status(200).json({ success: true, message: 'تم رفض العرض المضاد، ويبقى العرض بشروطه الأصلية', data });
    } catch (error) {
      next(error);
    }
  }

  public async getContractForSignature(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const offerId = typeof req.query.offerId === 'string' && req.query.offerId ? req.query.offerId : undefined;
      const data = await clientRequestsService.getContractForSignature(userId, req.params.id as string, offerId);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

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
