import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError, fieldError, zodAppError } from '../utils/app-error';
import { withTableGuard, isMissingTableError } from '../utils/missing-table';
import { uploadMulterFile } from '../utils/cloudinary-storage';

export const ASSET_KINDS = ['IMAGE', 'VIDEO', 'DOCUMENT', 'LINK', 'TEXT'] as const;
export const ASSET_AUDIENCES = ['MARKETER', 'ALL'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];
const DOC_MIME = ['application/pdf', 'application/zip', 'application/x-zip-compressed', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
export const MARKETING_ASSET_MIME_TYPES = new Set([...IMAGE_MIME, ...VIDEO_MIME, ...DOC_MIME]);
export const MARKETING_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MIME_BY_KIND: Record<string, string[]> = { IMAGE: IMAGE_MIME, VIDEO: VIDEO_MIME, DOCUMENT: DOC_MIME };

const bool = z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const optionalText = (max: number) => z.preprocess(v => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
const httpUrl = z.string().trim().max(1000).refine(v => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } }, 'رابط غير صالح (http/https فقط)');

const fields = {
	title: z.string().trim().min(2, 'العنوان مطلوب').max(150),
	description: optionalText(1000),
	kind: z.enum(ASSET_KINDS, { message: 'نوع المادة غير صحيح' }),
	audience: z.enum(ASSET_AUDIENCES, { message: 'الجمهور غير صحيح' }),
	active: bool,
	sortOrder: z.preprocess(v => (typeof v === 'string' && v !== '' ? Number(v) : v), z.number().int().min(0).max(100000)),
	linkUrl: z.preprocess(v => (v === '' ? null : v), httpUrl.nullable().optional()),
	text: optionalText(20000)
};
export const createAssetSchema = z.object({ ...fields, audience: fields.audience.default('MARKETER'), active: fields.active.default(true), sortOrder: fields.sortOrder.default(0) }).strict();
export const updateAssetSchema = z.object(fields).partial().strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
	const r = schema.safeParse(body ?? {});
	if (!r.success) throw zodAppError(r.error.issues, r.error.issues[0]?.message || 'بيانات غير صالحة');
	return r.data;
}

function assertKindPayload(kind: string, d: { linkUrl?: string | null; text?: string | null }, hasFile: boolean, file?: Express.Multer.File) {
	if (MIME_BY_KIND[kind]) {
		if (!hasFile) throw fieldError('file', 'ارفع ملفاً لهذا النوع من المواد');
		if (file && !MIME_BY_KIND[kind].includes(String(file.mimetype).toLowerCase())) throw new AppError('نوع الملف لا يطابق نوع المادة المختار', 415);
	} else if (kind === 'LINK') {
		if (!d.linkUrl) throw fieldError('linkUrl', 'الرابط مطلوب');
	} else if (kind === 'TEXT') {
		if (!d.text) throw fieldError('text', 'النص مطلوب');
	}
}

export interface AssetListFilter { kind?: string; audience?: string; active?: string; search?: string; page?: number; limit?: number }

export class MarketingAssetsService {
	async list(f: AssetListFilter) {
		const where: Record<string, unknown> = {};
		if (f.kind && (ASSET_KINDS as readonly string[]).includes(f.kind.toUpperCase())) where.kind = f.kind.toUpperCase();
		if (f.audience && (ASSET_AUDIENCES as readonly string[]).includes(f.audience.toUpperCase())) where.audience = f.audience.toUpperCase();
		if (f.active === 'true' || f.active === 'false') where.active = f.active === 'true';
		if (f.search?.trim()) where.title = { contains: f.search.trim(), mode: 'insensitive' };
		const page = Math.max(1, Number(f.page) || 1), limit = Math.min(100, Math.max(1, Number(f.limit) || 50));
		let items: Awaited<ReturnType<typeof prisma.marketingAsset.findMany>> = [], total = 0, storageReady = true;
		try {
			[items, total] = await prisma.$transaction([
				prisma.marketingAsset.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
				prisma.marketingAsset.count({ where })
			]);
		} catch (e) {
			// The marketing_assets table is not created yet: an empty list (page opens) flagged storageReady=false; adding is refused with a clear 503 in create().
			if (!isMissingTableError(e)) throw e;
			storageReady = false;
		}
		return { items, storageReady, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
	}

	async create(body: unknown, file: Express.Multer.File | undefined, adminId: string) {
		const d = parse(createAssetSchema, body);
		assertKindPayload(d.kind, d, !!file, file);
		const stored = file && MIME_BY_KIND[d.kind] ? await uploadMulterFile(file, 'waseetai/marketing-assets', MARKETING_ASSET_MAX_BYTES) : null;
		const asset = await withTableGuard(() => prisma.marketingAsset.create({ data: {
			title: d.title, description: d.description ?? null, kind: d.kind, audience: d.audience, active: d.active, sortOrder: d.sortOrder,
			fileUrl: stored?.url ?? null, fileName: stored?.fileName ?? null, mimeType: stored?.mimeType ?? null, fileBytes: stored?.bytes ?? null,
			linkUrl: d.kind === 'LINK' ? d.linkUrl ?? null : null, text: d.kind === 'TEXT' ? d.text ?? null : null, createdBy: adminId, updatedBy: adminId
		} }), 'مركز المواد التسويقية');
		return asset;
	}

	async update(id: string, body: unknown, file: Express.Multer.File | undefined, adminId: string) {
		const d = parse(updateAssetSchema, body);
		const existing = await withTableGuard(() => prisma.marketingAsset.findUnique({ where: { id } }), 'مركز المواد التسويقية');
		if (!existing) throw new AppError('المادة غير موجودة', 404);
		const kind = d.kind ?? existing.kind;
		const merged = { linkUrl: d.linkUrl !== undefined ? d.linkUrl : existing.linkUrl, text: d.text !== undefined ? d.text : existing.text };
		assertKindPayload(kind, merged, !!file || !!existing.fileUrl, file);
		const data: Record<string, unknown> = { updatedBy: adminId };
		for (const k of ['title', 'description', 'kind', 'audience', 'active', 'sortOrder'] as const) if (d[k] !== undefined) data[k] = d[k];
		if (file && MIME_BY_KIND[kind]) {
			const stored = await uploadMulterFile(file, 'waseetai/marketing-assets', MARKETING_ASSET_MAX_BYTES);
			Object.assign(data, { fileUrl: stored.url, fileName: stored.fileName, mimeType: stored.mimeType, fileBytes: stored.bytes });
		}
		if (kind === 'LINK') data.linkUrl = merged.linkUrl; else if (d.kind) data.linkUrl = null;
		if (kind === 'TEXT') data.text = merged.text; else if (d.kind) data.text = null;
		if (d.kind && !MIME_BY_KIND[kind] && !file) Object.assign(data, { fileUrl: null, fileName: null, mimeType: null, fileBytes: null });
		const updated = await withTableGuard(() => prisma.marketingAsset.update({ where: { id }, data }), 'مركز المواد التسويقية');
		return { before: existing, after: updated };
	}
}

export const marketingAssetsService = new MarketingAssetsService();
