import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/admin-access.middleware';
import { adminMessagesService, MESSAGE_PERMISSION } from '../services/admin-messages.service';
import { fieldError } from '../utils/app-error';

/**
 * /api/admin/messages - internal staff messaging. The router needs the `messages.use` permission; EVERY conversation route additionally checks that the caller is a member of that conversation
 * (the permission alone never opens somebody else's conversation, a SUPER_ADMIN included).
 */
const router = Router();
const ok = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.status(status).json({ success: true, data: await fn(req) }); } catch (e) { next(e); }
};
const only = (body: any, allowed: string[]) => {
	const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
	const extra = Object.keys(b).filter(k => !allowed.includes(k));
	if (extra.length) throw fieldError(extra[0], 'حقل غير مسموح');
	return b;
};
const me = (req: Request) => req.user!.id;
const id = (req: Request) => String(req.params.id);

router.use(authenticate, requireActiveUser, requirePermission(MESSAGE_PERMISSION));

router.get('/directory', ok(req => adminMessagesService.directory(me(req), typeof req.query.q === 'string' ? req.query.q : undefined)));
router.get('/conversations', ok(req => adminMessagesService.list(me(req), typeof req.query.q === 'string' ? req.query.q : undefined)));
router.post('/conversations', ok(req => adminMessagesService.startConversation(me(req), only(req.body, ['userId']).userId), 201));
router.get('/conversations/:id/messages', ok(req => adminMessagesService.messages(me(req), id(req), { before: req.query.before, limit: req.query.limit })));
router.post('/conversations/:id/messages', ok(req => { const b = only(req.body, ['body', 'clientMessageId']); return adminMessagesService.send(me(req), id(req), b); }, 201));
router.post('/conversations/:id/read', ok(req => adminMessagesService.markRead(me(req), id(req), only(req.body, ['upToSeq']).upToSeq)));
router.get('/unread-count', ok(async req => ({ unread: await adminMessagesService.unreadTotal(me(req)) })));

export default router;
