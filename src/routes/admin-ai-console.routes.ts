import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { AppError } from '../utils/app-error';
import { adminAiConsoleService } from '../services/admin-ai-console.service';

const query = z.object({
  days: z.enum(['7', '30', '90']).default('30'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  source: z.enum(['specialty', 'accreditation']).default('specialty'),
}).strict();
const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
for (const path of ['overview', 'audit', 'matching'] as const) {
  router.get('/' + path, async (req, res, next) => {
    try {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) throw new AppError('راجع الفترة ورقم الصفحة ومصدر السجل.', 400);
      const { days, page, source } = parsed.data;
      const data = path === 'overview'
        ? await adminAiConsoleService.overview(Number(days))
        : path === 'audit' ? await adminAiConsoleService.audit(Number(days), page, source)
        : await adminAiConsoleService.matching(Number(days), page);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });
}
export default router;
