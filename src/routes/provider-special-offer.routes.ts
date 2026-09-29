import { Router, Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AppError } from '../utils/app-error';
import { createSpecialOffer, deactivateSpecialOffer, decideSpecialOfferApproval, getSpecialOffer, getSpecialOfferStats, getSpecialOffersSummary, listSpecialOffers, updateSpecialOffer } from '../controllers/provider-special-offer.controller';

// Phase 6 — mounted at /provider/special-offers (see provider.routes.ts),
// i.e. /api/provider/special-offers. Middleware chains mirror the coupon
// routes in provider.routes.ts exactly.
//
// Same strict-accountType guard as provider.routes.ts / company-team.routes.ts
// (authorize(PROVIDER_COMPANY) alone also admits PROVIDER_INDIVIDUAL via
// role-equivalence). Duplicated rather than imported to avoid a circular
// import with provider.routes.ts, matching company-team.routes.ts.
const requireCompanyAccount = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.accountType !== AccountType.PROVIDER_COMPANY) {
    return next(new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403));
  }
  next();
};

const router = Router();
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.post('/', authenticate, requireActiveUser, providerOnly, createSpecialOffer);
router.get('/', authenticate, requireActiveUser, providerOnly, listSpecialOffers);
// /summary must be registered before /:id.
router.get('/summary', authenticate, requireActiveUser, providerOnly, getSpecialOffersSummary);
router.get('/:id/stats', authenticate, requireActiveUser, providerOnly, getSpecialOfferStats);
router.get('/:id', authenticate, requireActiveUser, providerOnly, getSpecialOffer);
router.put('/:id', authenticate, requireActiveUser, providerOnly, updateSpecialOffer);
router.delete('/:id', authenticate, requireActiveUser, providerOnly, deactivateSpecialOffer);
router.patch('/:id/approval', authenticate, requireActiveUser, authorize(AccountType.PROVIDER_COMPANY), requireCompanyAccount, decideSpecialOfferApproval);

export default router;
