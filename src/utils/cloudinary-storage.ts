import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import multer from 'multer';
import path from 'path';
import { AppError } from './app-error';
import { contentMatchesDeclaredType, looksLikeMarkup } from './file-signature';
import { isOwnCloudinaryUrl, ownCloudinaryUrlProblem } from './cloudinary-url';

export type CloudinaryResourceType = 'image' | 'video' | 'raw';

export interface StoredCloudFile {
	url: string;
	fileName: string;
	publicId: string;
	resourceType: CloudinaryResourceType;
	mimeType: string;
	bytes: number;
}

interface UploadCloudFileOptions {
	folder: string;
	fileName: string;
	mimeType?: string;
	resourceType?: CloudinaryResourceType;
	/** Hard ceiling for this upload (defaults to 15MB, the multer default). */
	maxBytes?: number;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

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
	ensureConfigured();
	const resourceType = options.resourceType || cloudinaryResourceType(mimeType);
	const extension = path.extname(options.fileName).replace('.', '');
	const baseName = path.basename(options.fileName, path.extname(options.fileName));
	const result = await uploadStream(buffer, {
		folder: options.folder.split('/').map(safeSegment).join('/'),
		public_id: `${safeSegment(baseName)}-${Date.now()}`,
		resource_type: resourceType,
		use_filename: false,
		unique_filename: true,
		overwrite: false,
		...(resourceType === 'raw' && extension ? { format: extension } : {})
	});

	return {
		url: result.secure_url,
		fileName: options.fileName,
		publicId: result.public_id,
		resourceType,
		mimeType,
		bytes: result.bytes
	};
}

export async function uploadMulterFile(file: Express.Multer.File, folder: string, maxBytes?: number): Promise<StoredCloudFile> {
	if (!file.buffer) throw new Error('The upload middleware must use memory storage');
	return uploadCloudFile(file.buffer, { folder, fileName: file.originalname, mimeType: file.mimetype, maxBytes });
}

export async function uploadDataUri(dataUri: string, options: Omit<UploadCloudFileOptions, 'mimeType'>): Promise<StoredCloudFile> {
	const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUri);
	if (!match) throw new AppError('صيغة الملف غير صالحة', 400);
	// Refuse oversized payloads from the base64 length BEFORE decoding them into memory.
	if (Math.floor((match[2].length * 3) / 4) > (options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES)) throw new AppError('حجم الملف يتجاوز الحد المسموح', 400);
	return uploadCloudFile(Buffer.from(match[2], 'base64'), { ...options, mimeType: match[1] });
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
	ensureConfigured();
	await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}

export function memoryUpload(options: { fileSize?: number; files?: number; allowedMimeTypes?: Set<string> } = {}) {
	return multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: options.fileSize || 15 * 1024 * 1024, files: options.files },
		fileFilter: options.allowedMimeTypes
			? (_req, file, callback) => options.allowedMimeTypes!.has(String(file.mimetype).toLowerCase().split(';')[0].trim())
				? callback(null, true)
				: callback(new AppError('نوع الملف غير مسموح به', 400))
			: undefined
	});
}
