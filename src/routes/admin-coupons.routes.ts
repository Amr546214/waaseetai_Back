import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { getCoupon, getSpecialOffer, listCoupons, listSpecialOffers, setCouponActive } from '../controllers/admin-coupons.controller';

// Mounted at /admin/coupons. Special offers (read-only) live on a sibling
// router export mounted at /admin/special-offers (see app.ts).
export const adminSpecialOffersRouter = Router();
const router = Router();
for (const r of [router, adminSpecialOffersRouter]) r.use(authenticate, requireActiveUser, authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN));

router.get('/', listCoupons);
router.get('/:id', getCoupon);
router.patch('/:id/active', setCouponActive);

adminSpecialOffersRouter.get('/', listSpecialOffers);
adminSpecialOffersRouter.get('/:id', getSpecialOffer);

export default router;
