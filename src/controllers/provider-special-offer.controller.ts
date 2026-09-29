import { Request, Response, NextFunction } from 'express';
import { createSpecialOfferSchema, updateSpecialOfferSchema, specialOfferApprovalDecisionSchema } from '../dtos/special-offer.dto';
import { providerSpecialOfferService } from '../services/provider-special-offer.service';
import { AppError } from '../utils/app-error';
import { parsePaging } from '../services/marketing-stats.util';

// Phase 6 — mirrors provider-coupon.controller.ts.
const providerId = (req: Request) => req.user?.id || req.user?.userId;
const parse = (schema: any, body: unknown) => {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError(result.error.issues[0]?.message || 'بيانات العرض غير صحيحة', 400);
  return result.data;
};

export async function createSpecialOffer(req: Request, res: Response, next: NextFunction) { try { res.status(201).json({ success: true, data: await providerSpecialOfferService.create(providerId(req)!, parse(createSpecialOfferSchema, req.body)) }); } catch (e) { next(e); } }
export async function listSpecialOffers(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.list(providerId(req)!) }); } catch (e) { next(e); } }
export async function getSpecialOffer(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.get(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
export async function updateSpecialOffer(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.update(providerId(req)!, String(req.params.id), parse(updateSpecialOfferSchema, req.body)) }); } catch (e) { next(e); } }
export async function deactivateSpecialOffer(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.remove(providerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
// Company-only approve/reject on a PENDING offer. Strict PROVIDER_COMPANY
// enforcement happens in the route (requireCompanyAccount), not here.
export async function decideSpecialOfferApproval(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.decideApproval(providerId(req)!, String(req.params.id), parse(specialOfferApprovalDecisionSchema, req.body)) }); } catch (e) { next(e); } }
// GET /provider/special-offers/summary — list-screen KPIs (bundle extra revenue).
export async function getSpecialOffersSummary(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.getSummary(providerId(req)!) }); } catch (e) { next(e); } }
// GET /provider/special-offers/:id/stats — per-offer usage stats (?page=&pageSize=).
export async function getSpecialOfferStats(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await providerSpecialOfferService.getStats(providerId(req)!, String(req.params.id), parsePaging(req.query as any)) }); } catch (e) { next(e); } }
