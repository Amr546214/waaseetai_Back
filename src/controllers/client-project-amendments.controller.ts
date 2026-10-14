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
      const data = await projectAmendmentService.respondToAmendment(userId, req.params.id as string, req.body?.decision, req.body?.otpCode);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /client/projects/amendments/:id/payment-otp — send the payment-authorization code for a budget increase (email, 2 minutes, bound to this amendment + amount)
  public async initPaymentAuthorization(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.initPaymentAuthorization(userId, req.params.id as string);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /client/projects/amendments/:id/authorize-funding — the client authorizes (OTP) the payment of a budget increase THEY raised; nothing is charged until the provider approves
  public async authorizeFunding(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.authorizeFunding(userId, req.params.id as string, req.body?.otpCode);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }

  // POST /client/projects/amendments/:id/cancel — withdraw a request this client raised and nobody answered yet
  public async cancelAmendment(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId || req.user!.id;
      const data = await projectAmendmentService.cancelAmendment(userId, 'CLIENT', req.params.id as string);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  }
}

export const clientProjectAmendmentsController = new ClientProjectAmendmentsController();
