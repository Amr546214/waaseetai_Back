import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import multer from 'multer';
import type { RequestHandler } from 'express';
import { uploadLimiter } from '../middlewares/rate-limit.middleware';
import path from 'path';
import { AppError } from './app-error';
import { contentMatchesDeclaredType, looksLikeMarkup } from './file-signature';
import { isOwnCloudinaryUrl, ownCloudinaryUrlProblem } from './cloudinary-url';
import { buildPrivateRef, parsePrivateRef } from './kyc-private-ref';

export type CloudinaryResourceType = 'image' | 'video' | 'raw';

export interface StoredCloudFile {
	url: string;
	fileName: string;
	publicId: string;
	resourceType: CloudinaryResourceType;
	mimeType: string;
	bytes: number;
	/** Set only for private uploads: the stored reference (private:<type>:<format>:<public_id>). `url` is NOT fetchable for those. */
	privateRef?: string;
}

interface UploadCloudFileOptions {
	folder: string;
	fileName: string;
	mimeType?: string;
	resourceType?: CloudinaryResourceType;
	/** Hard ceiling for this upload (defaults to 15MB, the multer default). */
	maxBytes?: number;
	/** KYC / confidential assets: uploaded with type=authenticated, so the plain URL is not fetchable. */
	private?: boolean;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function isLocalDevFallback(): boolean {
	return process.env.CLOUDINARY_CLOUD_NAME === 'local-dev';
}

function ensureConfigured(): void {
	const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
	const apiKey = process.env.CLOUDINARY_API_KEY;
	const apiSecret = process.env.CLOUDINARY_API_SECRET;
	if (!cloudName || !apiKey || !apiSecret) {
		throw new Error('Cloudinary configuration is missing (CloudName, CloudApiKey, CloudApiSecret)');
	}
	cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

function safeSegment(value: string): string {
	return value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'file';
}

export function cloudinaryResourceType(mimeType = ''): CloudinaryResourceType {
	if (mimeType.startsWith('image/') || mimeType === 'application/pdf') return 'image';
	if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'video';
	return 'raw';
}

function uploadStream(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
	return new Promise((resolve, reject) => {
		const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
			if (error || !result) reject(error || new Error('Cloudinary returned an empty upload result'));
			else resolve(result);
		});
		stream.end(buffer);
	});
}

export async function uploadCloudFile(buffer: Buffer, options: UploadCloudFileOptions): Promise<StoredCloudFile> {
	const mimeType = options.mimeType || 'application/octet-stream';
	if (buffer.length > (options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES)) throw new AppError('حجم الملف يتجاوز الحد المسموح', 400);
	// SVG (and any markup) can carry script and is served inline by the CDN: never accepted, whatever type the client declares.
	if (mimeType.toLowerCase().includes('svg') || looksLikeMarkup(buffer)) throw new AppError('ملفات SVG وملفات HTML غير مسموح برفعها', 400);
	// The declared type is client-controlled: for the types we can recognise (png/jpeg/gif/webp/pdf) the first bytes must agree with it.
	if (!contentMatchesDeclaredType(buffer, mimeType)) throw new AppError('محتوى الملف لا يطابق نوعه المعلن. ارفع صورة أو ملف PDF صالحاً.', 400);
	const resourceType = options.resourceType || cloudinaryResourceType(mimeType);
	const extension = path.extname(options.fileName).replace('.', '');
	const baseName = path.basename(options.fileName, path.extname(options.fileName));
	const cleanFolder = options.folder.split('/').map(safeSegment).join('/');
	const itemId = `${safeSegment(baseName)}-${Date.now()}`;
	if (isLocalDevFallback()) {
		const publicId = `${cleanFolder}/${itemId}`;
		const cleanExt = extension.replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
		const fmt = cleanExt || (mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'application/pdf' ? 'pdf' : 'bin');
		return {
			url: `https://res.cloudinary.com/local-dev/${resourceType}/upload/${publicId}.${fmt}`,
			fileName: options.fileName,
			publicId,
			resourceType,
			mimeType,
			bytes: buffer.length,
			...(options.private ? { privateRef: buildPrivateRef({ resourceType, format: fmt, publicId }) } : {})
		};
	}
	ensureConfigured();
	const result = await uploadStream(buffer, {
		folder: cleanFolder,
		public_id: itemId,
		resource_type: resourceType,
		use_filename: false,
		unique_filename: true,
		overwrite: false,
		...(options.private ? { type: 'authenticated' as const } : {}),
		...(resourceType === 'raw' && extension ? { format: extension } : {})
	});

	return {
		url: result.secure_url,
		fileName: options.fileName,
		publicId: result.public_id,
		resourceType,
		mimeType,
		bytes: result.bytes,
		...(options.private ? { privateRef: buildPrivateRef({ resourceType, format: result.format || extension || null, publicId: result.public_id }) } : {})
	};
}

export async function uploadMulterFile(file: Express.Multer.File, folder: string, maxBytes?: number, isPrivate = false): Promise<StoredCloudFile> {
	if (!file.buffer) throw new Error('The upload middleware must use memory storage');
	return uploadCloudFile(file.buffer, { folder, fileName: file.originalname, mimeType: file.mimetype, maxBytes, private: isPrivate });
}

export async function uploadDataUri(dataUri: string, options: Omit<UploadCloudFileOptions, 'mimeType'>): Promise<StoredCloudFile> {
	const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUri);
	if (!match) throw new AppError('صيغة الملف غير صالحة', 400);
	// Refuse oversized payloads from the base64 length BEFORE decoding them into memory.
	if (Math.floor((match[2].length * 3) / 4) > (options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES)) throw new AppError('حجم الملف يتجاوز الحد المسموح', 400);
	return uploadCloudFile(Buffer.from(match[2], 'base64'), { ...options, mimeType: match[1] });
}

/**
 * KYC / confidential files: a data: URI is uploaded PRIVATE and the stored private reference is returned (never a fetchable URL).
 * Any other value (empty, or a previously stored value that assertKycFileValues already accepted) is returned unchanged.
 */
export async function storeKycFileIfNeeded(value: string | null | undefined, folder: string, fileName: string): Promise<string | null | undefined> {
	if (!value?.startsWith('data:')) return value;
	return (await uploadDataUri(value, { folder, fileName, private: true })).privateRef;
}

/** Short-lived (default 120s) inline-viewable link for a stored private reference. */
export function createPrivateDownloadUrl(ref: string, ttlSeconds: number): { url: string; expiresAt: Date } | null {
	const parsed = parsePrivateRef(ref);
	if (!parsed) return null;
	const expiresAtSec = Math.floor(Date.now() / 1000) + ttlSeconds;
	if (isLocalDevFallback()) {
		return {
			url: `https://res.cloudinary.com/local-dev/${parsed.resourceType}/authenticated/${parsed.publicId}.${parsed.format || 'bin'}`,
			expiresAt: new Date(expiresAtSec * 1000)
		};
	}
	ensureConfigured();
	const url = cloudinary.utils.private_download_url(parsed.publicId, parsed.format || '', { resource_type: parsed.resourceType, type: 'authenticated', expires_at: expiresAtSec });
	return { url, expiresAt: new Date(expiresAtSec * 1000) };
}

/**
 * Stat check of a stored private reference against the storage itself (Cloudinary Admin API, type=authenticated): true when the object exists,
 * false when the storage answers "not found". Any other failure (network, quota, bad credentials) is thrown, so a caller fails CLOSED.
 */
export async function privateFileExists(ref: string): Promise<boolean> {
	const parsed = parsePrivateRef(ref);
	if (!parsed) return false;
	if (isLocalDevFallback()) return true;
	ensureConfigured();
	try {
		const res: any = await cloudinary.api.resource(parsed.publicId, { resource_type: parsed.resourceType, type: 'authenticated' });
		return !!res && res.public_id === parsed.publicId;
	} catch (e: any) {
		if ((e?.http_code ?? e?.error?.http_code) === 404) return false;
		throw e;
	}
}

export async function storeDataUriIfNeeded(value: string | null | undefined, folder: string, fileName: string): Promise<string | null | undefined> {
	if (!value?.startsWith('data:')) return value;
	return (await uploadDataUri(value, { folder, fileName })).url;
}

/**
 * Gallery/attachment URLs (projects, client requests, marketplace services): a data: URI is uploaded by us; a URL is accepted only when
 * it already lives in OUR Cloudinary account. Anything else is refused outright. The server never fetches a user-supplied URL (and never
 * forwards one to Cloudinary to fetch), so there is no SSRF or foreign-content path.
 */
export async function ensureCloudinaryUrl(value: string | null | undefined, folder: string, fileName: string): Promise<string | null | undefined> {
	if (!value) return value;
	if (value.startsWith('data:')) return storeDataUriIfNeeded(value, folder, fileName);
	const problem = ownCloudinaryUrlProblem(value);
	if (problem) throw new AppError(problem, 400);
	return value;
}

export { isOwnCloudinaryUrl };

export async function deleteCloudFile(publicId: string, resourceType: CloudinaryResourceType = 'image'): Promise<void> {
	if (isLocalDevFallback()) return;
	ensureConfigured();
	await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}

/** Puts the upload tier (per account, then per address) in front of a multer handler, so a refused request never buffers a file. */
function limitedFirst(handler: RequestHandler): RequestHandler {
	return (req, res, next) => uploadLimiter(req, res, (err?: unknown) => (err ? next(err as any) : handler(req, res, next)));
}

export function memoryUpload(options: { fileSize?: number; files?: number; allowedMimeTypes?: Set<string> } = {}): multer.Multer {
	const m = multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: options.fileSize || 15 * 1024 * 1024, files: options.files },
		fileFilter: options.allowedMimeTypes
			? (_req, file, callback) => options.allowedMimeTypes!.has(String(file.mimetype).toLowerCase().split(';')[0].trim())
				? callback(null, true)
				: callback(new AppError('نوع الملف غير مسموح به', 415))
			: undefined
	});
	// Every upload route in the app goes through here, so none can be added without the upload tier.
	return Object.assign(Object.create(m), {
		single: (name: string) => limitedFirst(m.single(name)),
		array: (name: string, max?: number) => limitedFirst(m.array(name, max)),
		fields: (specs: multer.Field[]) => limitedFirst(m.fields(specs)),
		any: () => limitedFirst(m.any()),
		none: () => limitedFirst(m.none())
	}) as multer.Multer;
}
