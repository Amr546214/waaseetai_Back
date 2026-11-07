import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/admin-access.middleware';
import { MARKET_VISIBLE_WHERE } from '../utils/market-visibility';
import { AppError, zodAppError } from '../utils/app-error';

const filing = z.object({ targetType: z.enum(['ACCOUNT', 'SERVICE']), targetId: z.string().uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
const decision = z.object({ status: z.enum(['RESOLVED', 'DISMISSED']), resolution: z.string().trim().min(5).max(2000) }).strict();
const listing = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).optional(), page: z.coerce.number().int().min(1).max(100_000).default(1) });
const publicPerson = { select: { firstName: true, lastName: true } } as const;
const adminSelect = { id: true, targetType: true, targetId: true, targetLabel: true, reason: true, status: true, resolution: true, reporter: publicPerson, reviewer: publicPerson, reviewedAt: true, createdAt: true } as const;
const errMissing = () => new AppError('البلاغ غير موجود', 404);
const knownId = (value: unknown) => {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) throw errMissing();
  return result.data;
};
const noStore = (_: unknown, res: { set(name: string, value: string): unknown }, next: () => void) => { res.set('Cache-Control', 'no-store'); next(); };

export const userPlatformReports = Router();
userPlatformReports.use(authenticate, requireActiveUser, noStore);
userPlatformReports.post('/', async (req, res, next) => {
  try {
    const input = filing.safeParse(req.body);
    if (!input.success) throw zodAppError(input.error.issues, 'اكتب سببًا واضحًا للبلاغ (من ١٠ إلى ٢٠٠٠ حرف).');
    const { targetType, targetId, reason } = input.data;
    const reporterId = req.user!.id;
    let targetLabel: string;
    if (targetType === 'ACCOUNT') {
      const target = await prisma.user.findFirst({ where: { id: targetId, status: 'ACTIVE', accountType: { notIn: ['ADMIN', 'SUPER_ADMIN'] } }, select: { id: true, firstName: true, lastName: true } });
      if (!target) throw new AppError('الحساب غير متاح للإبلاغ', 404);
      if (target.id === reporterId) throw new AppError('لا يمكنك الإبلاغ عن حسابك', 400);
      targetLabel = [target.firstName, target.lastName].filter(Boolean).join(' ') || 'حساب مستخدم';
    } else {
      const target = await prisma.serviceCatalog.findFirst({ where: { id: targetId, ...MARKET_VISIBLE_WHERE }, select: { title: true, providerId: true } });
      if (!target) throw new AppError('الخدمة غير متاحة للإبلاغ', 404);
      if (target.providerId === reporterId) throw new AppError('لا يمكنك الإبلاغ عن خدمتك', 400);
      targetLabel = target.title;
    }
    try {
      const data = await prisma.platformReport.create({ data: { reporterId, targetType, targetId, targetLabel, reason }, select: { id: true, status: true } });
      res.status(201).json({ success: true, data });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw new AppError('عندك بلاغ مفتوح عن نفس العنصر', 409);
      throw error;
    }
  } catch (error) { next(error); }
});

export const adminPlatformReports = Router();
adminPlatformReports.use(authenticate, requireActiveUser, requirePermission('reports.view'), noStore);
adminPlatformReports.get('/', async (req, res, next) => {
  try {
    const query = listing.safeParse(req.query);
    if (!query.success) throw new AppError('فلتر البلاغات غير صالح', 400);
    const { status, page } = query.data;
    const where = status ? { status } : {};
    const [items, total] = await prisma.$transaction([
      prisma.platformReport.findMany({ where, select: { id: true, targetLabel: true, targetType: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20 }),
      prisma.platformReport.count({ where }),
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.max(1, Math.ceil(total / 20)) } });
  } catch (error) { next(error); }
});
adminPlatformReports.get('/:id', async (req, res, next) => {
  try {
    const data = await prisma.platformReport.findUnique({ where: { id: knownId(req.params.id) }, select: adminSelect });
    if (!data) throw errMissing();
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
adminPlatformReports.patch('/:id', requirePermission('reports.manage'), async (req, res, next) => {
  try {
    const id = knownId(req.params.id);
    const input = decision.safeParse(req.body);
    if (!input.success) throw zodAppError(input.error.issues, 'اختر القرار واكتب سببه.');
    const saved = await prisma.platformReport.updateMany({
      where: { id, status: 'OPEN' }, data: { ...input.data, reviewerId: req.user!.id, reviewedAt: new Date() },
    });
    if (!saved.count) {
      if (!(await prisma.platformReport.findUnique({ where: { id }, select: { id: true } }))) throw errMissing();
      throw new AppError('تم اتخاذ قرار في البلاغ بالفعل. حدّث الصفحة.', 409);
    }
    res.json({ success: true, data: await prisma.platformReport.findUnique({ where: { id }, select: adminSelect }) });
  } catch (error) { next(error); }
});
