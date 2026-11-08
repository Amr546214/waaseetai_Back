import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { AUDIENCE_TYPES } from '../services/admin-broadcast.service';
import { AppError } from '../utils/app-error';

const query = z.object({ audience: z.enum(['CLIENTS', 'PROVIDERS', 'MARKETERS']) }).strict();
const audiences = AUDIENCE_TYPES;

const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);
router.get('/', async (req, res, next) => {
  try {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) throw new AppError('اختر جمهورًا صالحًا للمعاينة.', 400);
    const { audience } = parsed.data;
    const count = await prisma.user.count({
      where: { accountType: { in: audiences[audience] }, status: 'ACTIVE', isBanned: false },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { audience, count, checkedAt: new Date().toISOString() } });
  } catch (error) { next(error); }
});

export default router;
