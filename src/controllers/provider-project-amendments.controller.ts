import { Request, Response, NextFunction } from 'express';
import { projectAmendmentService } from '../services/project-amendment.service';

export class ProviderProjectAmendmentsController {
  // GET /provider/projects/:projectId/amendments — the provider's own requests for this project, with their status.
  public async list(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.listProviderAmendments(userId, req.params.projectId as string);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /provider/projects/:projectId/amendments — a formal change request; it waits for the client and changes nothing by itself.
  public async create(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.createProviderAmendment(userId, req.params.projectId as string, req.body || {});
      res.status(201).json({ success: true, message: 'تم تسجيل طلب التعديل وهو بانتظار رد العميل', data });
    } catch (error) { next(error); }
  }

  // POST /provider/amendments/:id/respond — the provider answers a request the CLIENT raised (approve applies it to the contract, reject changes nothing).
  public async respond(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.respondToAmendmentAsProvider(userId, req.params.id as string, req.body?.decision);
      const approved = req.body?.decision === 'approve';
      res.status(200).json({ success: true, message: approved ? 'تم اعتماد التعديل وتطبيقه على العقد' : 'تم تسجيل رفضك لطلب التعديل', data });
    } catch (error) { next(error); }
  }

  // POST /provider/amendments/:id/cancel — withdraw a request this provider raised and nobody answered yet.
  public async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.cancelAmendment(userId, 'PROVIDER', req.params.id as string);
      res.status(200).json({ success: true, message: 'تم إلغاء طلب التعديل', data });
    } catch (error) { next(error); }
  }
}

export const providerProjectAmendmentsController = new ProviderProjectAmendmentsController();
