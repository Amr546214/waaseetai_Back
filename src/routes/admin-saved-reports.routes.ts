import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { REPORT_PERIODS, REPORT_SECTIONS, isReportDate, validReportRange } from '../services/admin-saved-report-config';

const date = z.string().refine(isReportDate).nullable();
const input = z.object({
  name: z.string().trim().min(1).max(80),
  section: z.enum(REPORT_SECTIONS),
  period: z.enum(REPORT_PERIODS),
  from: date,
  to: date,
  compare: z.boolean(),
}).strict().refine(v => validReportRange(v.period, v.from, v.to));
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).strict();
const select = { id: true, name: true, section: true, period: true, from: true, to: true, compare: true } as const;
const size = 20;
const router = Router();

// Mounted below the analytics router's authentication, active-user and finance.read guards.
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/', async (req, res) => {
  const page = pageQuery.safeParse(req.query);
  if (!page.success) throw new AppError('رقم الصفحة غير صالح.', 400);
  const rows = await prisma.adminSavedReport.findMany({
    where: { ownerId: req.user!.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page.data - 1) * size,
    take: size + 1,
    select,
  });
  res.json({ success: true, data: { items: rows.slice(0, size), hasNext: page.data < 10_000 && rows.length > size } });
});

router.post('/', async (req, res) => {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) throw new AppError('راجع اسم التقرير والفترة المحددة.', 400);
  const data = await prisma.adminSavedReport.create({ data: { ...parsed.data, ownerId: req.user!.id }, select });
  res.status(201).json({ success: true, data });
});

router.delete('/:id', async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AppError('التقرير المحفوظ غير موجود.', 404);
  const result = await prisma.adminSavedReport.deleteMany({ where: { id: id.data, ownerId: req.user!.id } });
  if (!result.count) throw new AppError('التقرير المحفوظ غير موجود.', 404);
  res.status(204).end();
});

export default router;
