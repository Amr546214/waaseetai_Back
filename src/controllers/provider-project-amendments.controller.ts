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
}

export const providerProjectAmendmentsController = new ProviderProjectAmendmentsController();
