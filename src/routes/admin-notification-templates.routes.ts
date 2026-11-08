import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { AppError, zodAppError } from '../utils/app-error';

const fields = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(2000),
}).strict();
const revision = fields.extend({ version: z.number().int().min(1).max(2_147_483_646) });
const query = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).strict();
const size = 20;
const select = { id: true, name: true, title: true, message: true, version: true, updatedAt: true } as const;
const notFound = () => new AppError('القالب غير موجود.', 404);
const mutationError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
    ? new AppError('يوجد قالب بنفس الاسم. اختر اسمًا مختلفًا.', 409) : error;

const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/', async (req, res, next) => {
  try {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) throw new AppError('رقم الصفحة غير صالح.', 400);
    const { page } = parsed.data;
    const rows = await prisma.notificationTemplate.findMany({
      select, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size + 1,
    });
    res.json({ success: true, data: { page, items: rows.slice(0, size), hasNext: page < 10_000 && rows.length > size } });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = fields.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, 'راجع اسم القالب والعنوان والنص.');
    res.status(201).json({ success: true, data: await prisma.notificationTemplate.create({ data: parsed.data, select }) });
  } catch (error) { next(mutationError(error)); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound();
    const parsed = revision.safeParse(req.body);
    if (!parsed.success) throw zodAppError(parsed.error.issues, 'راجع اسم القالب والعنوان والنص.');
    const { version, ...changes } = parsed.data;
    const data = await prisma.$transaction(async tx => {
      const result = await tx.notificationTemplate.updateMany({ where: { id: id.data, version }, data: { ...changes, version: { increment: 1 } } });
      if (!result.count) {
        if (!(await tx.notificationTemplate.findUnique({ where: { id: id.data }, select: { id: true } }))) throw notFound();
        throw new AppError('القالب اتعدّل من جلسة أخرى. افتح النسخة الأخيرة قبل الحفظ.', 409, undefined, 'NOTIFICATION_TEMPLATE_CHANGED');
      }
      return tx.notificationTemplate.findUniqueOrThrow({ where: { id: id.data }, select });
    });
    res.json({ success: true, data });
  } catch (error) { next(mutationError(error)); }
});

export default router;
