import { Request, Response, NextFunction } from 'express';
import { projectAmendmentService } from '../services/project-amendment.service';

export class ClientProjectAmendmentsController {
  // GET /client/projects/amendments
  public async listAmendments(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.listAmendments(userId);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /client/projects/:projectId/amendments
  public async createAmendment(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.createAmendment(userId, req.params.projectId as string, req.body || {});
      res.status(201).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /client/projects/amendments/:id/respond
  public async respondToAmendment(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.respondToAmendment(userId, req.params.id as string, req.body?.decision);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }
}

export const clientProjectAmendmentsController = new ClientProjectAmendmentsController();
