import { Router, Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AppError } from '../utils/app-error';
import { getMarketingCenter, updateMarketingSpendCap } from '../controllers/marketing-center.controller';

// Phase 7 — mounted at /provider/marketing (see provider.routes.ts), i.e.
//   GET   /api/provider/marketing/center     (individual + company)
//   PATCH /api/provider/marketing/spend-cap  (company only)
// Same strict-accountType guard as provider-special-offer.routes.ts
// (duplicated to avoid a circular import with provider.routes.ts).
const requireCompanyAccount = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.accountType !== AccountType.PROVIDER_COMPANY) {
    return next(new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403));
  }
  next();
};

const router = Router();
const providerOnly = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

router.get('/center', authenticate, requireActiveUser, providerOnly, getMarketingCenter);
router.patch('/spend-cap', authenticate, requireActiveUser, authorize(AccountType.PROVIDER_COMPANY), requireCompanyAccount, updateMarketingSpendCap);

export default router;
