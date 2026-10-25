import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { memoryUpload } from '../utils/cloudinary-storage';
import { marketingAssetsService, MARKETING_ASSET_MIME_TYPES, MARKETING_ASSET_MAX_BYTES } from '../services/marketing-assets.service';
import { recordAdminAudit } from '../utils/admin-audit';
import { AppError } from '../utils/app-error';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('marketing_assets.manage'));

const upload = memoryUpload({ fileSize: MARKETING_ASSET_MAX_BYTES, files: 1, allowedMimeTypes: MARKETING_ASSET_MIME_TYPES });
const brief = (a: any) => a && ({ title: a.title, kind: a.kind, audience: a.audience, active: a.active, sortOrder: a.sortOrder, hasFile: !!a.fileUrl, linkUrl: a.linkUrl, description: a.description });

router.get('/', async (req, res, next) => {
	try {
		const q = req.query as Record<string, string | undefined>;
		res.json({ success: true, data: await marketingAssetsService.list({ kind: q.kind, audience: q.audience, active: q.active, search: q.search, page: Number(q.page), limit: Number(q.limit) }) });
	} catch (e) { next(e); }
});

router.post('/', upload.single('file'), async (req, res, next) => {
	try {
		const asset = await marketingAssetsService.create(req.body, req.file, req.user!.id);
		await recordAdminAudit(req, { eventType: 'MARKETING_ASSET_CREATED', title: 'إضافة مادة تسويقية', summary: `إضافة مادة تسويقية: ${asset.title}`, after: brief(asset), details: { assetId: asset.id } });
		res.status(201).json({ success: true, message: 'تمت إضافة المادة', data: asset });
	} catch (e) { next(e); }
});

router.patch('/:id', upload.single('file'), async (req, res, next) => {
	try {
		const id = String(req.params.id);
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('معرّف غير صالح', 400);
		const { before, after } = await marketingAssetsService.update(id, req.body, req.file, req.user!.id);
		const toggled = before.active !== after.active;
		await recordAdminAudit(req, {
			eventType: toggled ? (after.active ? 'MARKETING_ASSET_ENABLED' : 'MARKETING_ASSET_DISABLED') : 'MARKETING_ASSET_UPDATED',
			title: toggled ? (after.active ? 'تفعيل مادة تسويقية' : 'تعطيل مادة تسويقية') : 'تعديل مادة تسويقية',
			summary: `${toggled ? (after.active ? 'تفعيل' : 'تعطيل') : 'تعديل'} المادة التسويقية: ${after.title}`, before: brief(before), after: brief(after), details: { assetId: id }
		});
		res.json({ success: true, message: 'تم تحديث المادة', data: after });
	} catch (e) { next(e); }
});

export default router;
