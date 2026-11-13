import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { AppError } from '../utils/app-error';

const DAY = 86_400_000;
const PAGE = 25;
const querySchema = z.object({
  range: z.enum(['24h', '7d']).default('24h'),
  category: z.enum(['ALL', 'OFFERS', 'PROJECTS', 'FINANCIAL', 'AI']).optional(),
  source: z.enum(['SYSTEM','ADMIN']).optional(),
  read: z.enum(['read', 'unread']).optional(),
  beforeAt: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
}).strict().refine(q => !!q.beforeAt === !!q.beforeId);

const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);
router.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError('فلاتر سجل الإشعارات غير صالحة.', 400);
    const { range, category, read, source, beforeAt, beforeId } = parsed.data;
    const cutoff = new Date(Date.now() - (range === '7d' ? 7 : 1) * DAY);
    const where: Prisma.NotificationWhereInput = { createdAt: { gte: cutoff } };
    if (source) where.type = source === 'ADMIN' ? { in: ['ADMIN_BROADCAST','ADMIN_MESSAGE'] } : { notIn: ['ADMIN_BROADCAST','ADMIN_MESSAGE'] };
    if (category) where.category = category;
    if (read) where.isRead = read === 'read';
    if (beforeAt && beforeId) {
      const at = new Date(beforeAt);
      where.OR = [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: beforeId } }];
    }
    // Only operational metadata. No recipients, subject, body, links or raw metadata.
    const rows = await prisma.notification.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE + 1,
      select: { id: true, category: true, type: true, isRead: true, createdAt: true, title: true, message: true },
    });
    const deliveries = rows.some(r=>r.type==='ADMIN_BROADCAST') ? await prisma.adminBroadcastDelivery.findMany({ where:{notificationId:{in:rows.filter(r=>r.type==='ADMIN_BROADCAST').map(r=>r.id)}},select:{notificationId:true,status:true,emailStatus:true,emailError:true} }) : [];
    const items = rows.slice(0, PAGE).map(({title,message,...row})=>({...row,source:row.type==='ADMIN_BROADCAST'||row.type==='ADMIN_MESSAGE'?'ADMIN':'SYSTEM',...(row.type==='ADMIN_BROADCAST'?{title,message,delivery:deliveries.find(d=>d.notificationId===row.id)}:{})}));
    const last = items.at(-1);
    const nextCursor = rows.length > PAGE && last ? { beforeAt: last.createdAt.toISOString(), beforeId: last.id } : null;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { items, nextCursor } });
  } catch (error) { next(error); }
});
export default router;
