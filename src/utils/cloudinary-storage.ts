import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import multer from 'multer';
import path from 'path';

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
	ensureConfigured();
	const mimeType = options.mimeType || 'application/octet-stream';
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

export async function uploadMulterFile(file: Express.Multer.File, folder: string): Promise<StoredCloudFile> {
	if (!file.buffer) throw new Error('The upload middleware must use memory storage');
	return uploadCloudFile(file.buffer, { folder, fileName: file.originalname, mimeType: file.mimetype });
}

export async function uploadDataUri(dataUri: string, options: Omit<UploadCloudFileOptions, 'mimeType'>): Promise<StoredCloudFile> {
	const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUri);
	if (!match) throw new Error('Invalid Base64 data URI');
	return uploadCloudFile(Buffer.from(match[2], 'base64'), { ...options, mimeType: match[1] });
}

export async function storeDataUriIfNeeded(value: string | null | undefined, folder: string, fileName: string): Promise<string | null | undefined> {
	if (!value?.startsWith('data:')) return value;
	return (await uploadDataUri(value, { folder, fileName })).url;
}

export async function ensureCloudinaryUrl(value: string | null | undefined, folder: string, fileName: string): Promise<string | null | undefined> {
	if (!value) return value;
	if (value.startsWith('data:')) return storeDataUriIfNeeded(value, folder, fileName);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('رابط الملف غير صالح');
	}
	if (parsed.protocol !== 'https:') throw new Error('يجب أن يكون رابط الملف آمناً HTTPS');
	if (parsed.hostname === 'res.cloudinary.com') return value;
	ensureConfigured();
	const result = await cloudinary.uploader.upload(value, {
		folder: folder.split('/').map(safeSegment).join('/'),
		public_id: `${safeSegment(fileName)}-${Date.now()}`,
		resource_type: 'auto',
		unique_filename: true,
		overwrite: false
	});
	return result.secure_url;
}

export async function deleteCloudFile(publicId: string, resourceType: CloudinaryResourceType = 'image'): Promise<void> {
	ensureConfigured();
	await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}

export function memoryUpload(options: { fileSize?: number; files?: number; allowedMimeTypes?: Set<string> } = {}) {
	return multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: options.fileSize || 15 * 1024 * 1024, files: options.files },
		fileFilter: options.allowedMimeTypes
			? (_req, file, callback) => options.allowedMimeTypes!.has(file.mimetype)
				? callback(null, true)
				: callback(new Error('نوع الملف غير مسموح به'))
			: undefined
	});
}
