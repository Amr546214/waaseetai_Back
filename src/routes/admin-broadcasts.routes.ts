import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/admin-access.middleware';
import { AppError, zodAppError } from '../utils/app-error';
import { activeBroadcast, DraftConflict, drafts, historyDetail, listHistory, previewDraft, retryRemaining, sendBroadcast, validIdempotencyKey } from '../services/admin-broadcast.service';

// Permission choice: Super Admin only (requireSuperAdmin), like the audience preview (#227), templates and notification history. No registry permission fits "message a whole audience",
// and a broadcast is irreversible, so it is not delegable to staff roles.
const fields = {
	title: z.string().trim().max(150),
	message: z.string().trim().max(2000),
	category: z.enum(['ALL', 'OFFERS', 'PROJECTS', 'FINANCIAL', 'AI']),
	audience: z.enum(['CLIENTS', 'PROVIDERS', 'MARKETERS']).nullable(),
};
const version = z.number().int().min(1).max(2_147_483_646);
const createBody = z.object(fields).partial().strict();
const updateBody = z.object({ ...fields, version }).partial().required({ version: true }).strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1).max(2_147_483_646).optional() }).strict();
const sendBody = z.object({ previewToken: z.string().min(10).max(2000) }).strict();
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).strict();
const BAD = 'راجع العنوان والنص والفئة والجمهور.';

const uuid = (value: unknown, what: string) => {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) throw new AppError(what, 404);
	return parsed.data;
};
const conflict = (res: Response, current: unknown) =>
	res.status(409).json({ success: false, code: 'BROADCAST_DRAFT_CHANGED', message: 'المسودة اتعدّلت من جلسة أخرى. هذه آخر نسخة محفوظة.', data: { current } });

const router = Router();
router.use(authenticate, requireActiveUser, requireSuperAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const me = (req: { user?: { id?: string } }) => req.user!.id!;

router.post('/drafts', async (req, res, next) => {
	try {
		const parsed = createBody.safeParse(req.body ?? {});
		if (!parsed.success) throw zodAppError(parsed.error.issues, BAD);
		res.status(201).json({ success: true, data: await drafts.create(me(req), parsed.data) });
	} catch (e) { next(e); }
});
router.get('/drafts/latest', async (req, res, next) => {
	try { res.json({ success: true, data: await drafts.latest(me(req)) }); } catch (e) { next(e); }
});
router.get('/drafts/:id', async (req, res, next) => {
	try { res.json({ success: true, data: await drafts.get(me(req), uuid(req.params.id, 'المسودة غير موجودة.')) }); } catch (e) { next(e); }
});
router.patch('/drafts/:id', async (req, res, next) => {
	try {
		const id = uuid(req.params.id, 'المسودة غير موجودة.');
		const parsed = updateBody.safeParse(req.body);
		if (!parsed.success) throw zodAppError(parsed.error.issues, BAD);
		const { version: v, ...changes } = parsed.data;
		res.json({ success: true, data: await drafts.update(me(req), id, v, changes) });
	} catch (e) { if (e instanceof DraftConflict) { conflict(res, e.current); return; } next(e); }
});
router.delete('/drafts/:id', async (req, res, next) => {
	try {
		const id = uuid(req.params.id, 'المسودة غير موجودة.');
		const q = deleteQuery.safeParse(req.query);
		if (!q.success) throw new AppError('رقم النسخة غير صالح.', 400);
		await drafts.remove(me(req), id, q.data.version);
		res.json({ success: true, data: { id } });
	} catch (e) { if (e instanceof DraftConflict) { conflict(res, e.current); return; } next(e); }
});
router.post('/drafts/:id/preview', async (req, res, next) => {
	try { res.json({ success: true, data: await previewDraft(me(req), uuid(req.params.id, 'المسودة غير موجودة.')) }); } catch (e) { next(e); }
});
router.post('/drafts/:id/send', async (req, res, next) => {
	try {
		const id = uuid(req.params.id, 'المسودة غير موجودة.');
		const key = req.header('Idempotency-Key');
		if (!validIdempotencyKey(key)) throw new AppError('مفتاح الإرسال (Idempotency-Key) مطلوب.', 400, undefined, 'IDEMPOTENCY_KEY_REQUIRED');
		const parsed = sendBody.safeParse(req.body);
		if (!parsed.success) throw new AppError('أرسل رمز المعاينة. اعمل معاينة جديدة أولًا.', 400, undefined, 'PREVIEW_TOKEN_REQUIRED');
		const result = await sendBroadcast({ adminId: me(req), draftId: id, idempotencyKey: key, previewToken: parsed.data.previewToken });
		res.status(result.replayed ? 200 : 202).json({ success: true, data: result });
	} catch (e) { next(e); }
});
router.get('/', async (req, res, next) => {
	try {
		const q = pageQuery.safeParse(req.query);
		if (!q.success) throw new AppError('رقم الصفحة غير صالح.', 400);
		res.json({ success: true, data: await listHistory(q.data.page) });
	} catch (e) { next(e); }
});
router.get('/active', async (req, res, next) => {
	try { res.json({ success: true, data: await activeBroadcast(me(req)) }); } catch (e) { next(e); }
});
router.get('/:id', async (req, res, next) => {
	try { res.json({ success: true, data: await historyDetail(uuid(req.params.id, 'الإشعار الجماعي غير موجود.')) }); } catch (e) { next(e); }
});
router.post('/:id/retry', async (req, res, next) => {
	try { res.json({ success: true, data: await retryRemaining(me(req), uuid(req.params.id, 'الإشعار الجماعي غير موجود.')) }); } catch (e) { next(e); }
});

export default router;
