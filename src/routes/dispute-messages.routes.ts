import { Router, type RequestHandler } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { requirePermission } from '../middlewares/admin-access.middleware';
import { actorHas } from '../services/admin-access.service';
import { AppError } from '../utils/app-error';

const pageSize = 30;
const idSchema = z.string().uuid();
const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
const disputeFields = { openedById: true, againstUserId: true, status: true } as const;
const messageFields = { id: true, authorId: true, authorKind: true, body: true, createdAt: true } as const;

const notFound = () => new AppError('النزاع غير موجود', 404);
const isOpen = (status: string) => status === 'OPEN' || status === 'UNDER_REVIEW';

function assertAccess(dispute: { openedById: string; againstUserId: string | null; status: string } | null, userId: string, staff: boolean) {
  if (!dispute || (!staff && dispute.openedById !== userId && dispute.againstUserId !== userId)) throw notFound();
  return dispute;
}

function present(message: Prisma.DisputeMessageGetPayload<{ select: typeof messageFields }>, userId: string) {
  const { authorId, ...data } = message;
  return { ...data, own: authorId === userId };
}

/** Parent supplies authentication, active account and, for staff, disputes.view. */
export function disputeMessagesRouter(staff: boolean, db = prisma) {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  router.get('/', async (req, res, next) => {
    try {
      const id = idSchema.safeParse((req.params as { id?: string }).id);
      if (!id.success) throw notFound();
      const disputeId = id.data;
      const userId = req.user!.id;
      const dispute = assertAccess(await db.dispute.findUnique({ where: { id: disputeId }, select: disputeFields }), userId, staff);
      let before: { createdAt: Date; id: string } | null = null;
      if (req.query.before !== undefined) {
        const cursor = idSchema.safeParse(req.query.before);
        if (!cursor.success) throw new AppError('مؤشر الرسائل غير صالح', 400);
        before = await db.disputeMessage.findFirst({ where: { id: cursor.data, disputeId }, select: { createdAt: true, id: true } });
        if (!before) throw new AppError('مؤشر الرسائل غير صالح', 400);
      }
      const messages = await db.disputeMessage.findMany({
        where: { disputeId, ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize + 1, select: messageFields,
      });
      const visible = messages.slice(0, pageSize);
      res.json({ data: {
        messages: visible.reverse().map(message => present(message, userId)),
        before: messages.length > pageSize ? visible[0].id : null,
        open: isOpen(dispute.status),
        canSend: isOpen(dispute.status) && (!staff || (!!req.adminActor && actorHas(req.adminActor, 'messages.use'))),
      } });
    } catch (error) { next(error); }
  });

  router.post('/', ...(staff ? [requirePermission('messages.use')] : []), async (req, res, next) => {
    try {
      const id = idSchema.safeParse((req.params as { id?: string }).id);
      if (!id.success) throw notFound();
      const disputeId = id.data;
      const userId = req.user!.id;
      const input = messageSchema.safeParse(req.body);
      if (!input.success) throw new AppError('اكتب رسالة من 1 إلى 2000 حرف', 400);
      const message = await db.$transaction(async tx => {
        // Same row that a status update writes; once closed, no late message can be saved.
        const rows = await tx.$queryRaw<Array<{ openedById: string; againstUserId: string | null; status: string }>>`
          SELECT "openedById", "againstUserId", status::text AS status FROM "disputes" WHERE id = ${disputeId} FOR UPDATE
        `;
        const dispute = assertAccess(rows[0] ?? null, userId, staff);
        if (!isOpen(dispute.status)) throw new AppError('النزاع مغلق؛ يمكنك قراءة الرسائل السابقة فقط', 409);
        return tx.disputeMessage.create({
          data: { disputeId, authorId: userId, authorKind: staff ? 'STAFF' : 'PARTICIPANT', body: input.data.body },
          select: messageFields,
        });
      });
      res.status(201).json({ data: present(message, userId) });
    } catch (error) { next(error); }
  });
  return router;
}

export function mountDisputeMessages(parent: Router, path: string, staff: boolean, ...guards: RequestHandler[]) {
  parent.use(path, ...guards, disputeMessagesRouter(staff));
  const layer = parent.stack.at(-1) as unknown as { __swaggerPath?: string } | undefined;
  if (layer) layer.__swaggerPath = path;
}
