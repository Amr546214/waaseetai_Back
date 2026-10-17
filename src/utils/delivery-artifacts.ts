// Stage-delivery artifacts: what a provider may attach to a delivery. Pure (no DB, no network, no Cloudinary SDK).
//
// A delivery must carry at least ONE real artifact: either a file uploaded through the delivery upload endpoint (its URL lives in OUR
// Cloudinary account under this provider's folder for THIS stage) or a plain https link. A bare file name is never an artifact.
// The server never fetches any of these URLs.
import { AppError } from './app-error';
import { isOwnCloudinaryUrl } from './cloudinary-url';

export const DELIVERY_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DELIVERY_MAX_UPLOADED_FILES = 5;
export const DELIVERY_MAX_LINKS = 5;
const MAX_URL_LENGTH = 2048;

/** Cloudinary folder every delivery upload goes to. A stored URL must contain this exact path to count as "uploaded for this stage". */
export const deliveryFolder = (providerId: string, stageId: string) => `waseetai/deliveries/${providerId}/${stageId}`;

export interface DeliveryFileInfo {
	name: string;
	url: string;
	type: string;
	size: number;
}

const preview = (value: string) => value.replace(/\s+/g, ' ').slice(0, 40);

/** Why a URL cannot be a delivery link (null = fine). https only, no credentials/odd ports, no IP literal / localhost / single-label host. */
export function deliveryLinkProblem(value: string): string | null {
	if (value.length > MAX_URL_LENGTH) return 'رابط التسليم طويل جداً';
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return `كل مرفق يجب أن يكون ملفاً مرفوعاً فعلياً أو رابط https صحيحاً (تم رفض: «${preview(value)}»)`;
	}
	if (url.protocol !== 'https:') return 'يجب أن يكون رابط التسليم https';
	if (url.username || url.password) return 'رابط التسليم لا يجوز أن يحمل بيانات دخول';
	if (url.port && url.port !== '443') return 'رابط التسليم يجب أن يستخدم المنفذ الافتراضي';
	const host = url.hostname.toLowerCase();
	if (host.startsWith('[') || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'رابط التسليم لا يجوز أن يكون عنوان IP';
	if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return 'رابط التسليم غير صالح';
	return null;
}

const isCloudinaryHost = (value: string) => {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === 'cloudinary.com' || host.endsWith('.cloudinary.com');
	} catch {
		return false;
	}
};

const cleanText = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/**
 * Validates the `files` payload of a stage delivery and returns the strings to store in StageDelivery.files:
 * an uploaded file -> JSON {name,url,type,size}; a link -> the plain https URL. Throws AppError(400) otherwise.
 */
export function validateDeliveryArtifacts(providerId: string, stageId: string, raw: unknown): string[] {
	const entries = Array.isArray(raw) ? raw.filter(v => v !== null && v !== undefined) : [];
	const folderPath = `/${deliveryFolder(providerId, stageId)}/`;
	const seen = new Set<string>();
	const stored: string[] = [];
	let uploaded = 0;
	let links = 0;

	for (const entry of entries) {
		let url = '';
		let info: Partial<DeliveryFileInfo> | null = null;
		if (typeof entry === 'string') {
			url = entry.trim();
		} else if (typeof entry === 'object') {
			const o = entry as Record<string, unknown>;
			url = cleanText(o.url ?? o.fileUrl, MAX_URL_LENGTH + 1);
			info = { name: cleanText(o.name ?? o.fileName, 200), type: cleanText(o.type ?? o.mimeType, 100), size: typeof o.size === 'number' && o.size >= 0 ? o.size : 0 };
		}
		if (!url) throw new AppError('كل مرفق يجب أن يكون ملفاً مرفوعاً فعلياً أو رابط https صحيحاً', 400);

		const problem = deliveryLinkProblem(url);
		if (problem) throw new AppError(problem, 400);
		if (seen.has(url)) continue;
		seen.add(url);

		if (isCloudinaryHost(url)) {
			// A file we host: it must be OUR account AND the folder of this provider's upload for this very stage.
			if (!isOwnCloudinaryUrl(url) || !new URL(url).pathname.includes(folderPath)) {
				throw new AppError('الملف المرفوع غير تابع لهذه المرحلة؛ ارفع الملف من جهازك مجدداً', 400);
			}
			if (++uploaded > DELIVERY_MAX_UPLOADED_FILES) throw new AppError(`الحد الأقصى ${DELIVERY_MAX_UPLOADED_FILES} ملفات مرفوعة للتسليم الواحد`, 400);
			stored.push(JSON.stringify({ name: info?.name || decodeName(url), url, type: info?.type || '', size: info?.size || 0 }));
		} else {
			if (++links > DELIVERY_MAX_LINKS) throw new AppError(`الحد الأقصى ${DELIVERY_MAX_LINKS} روابط للتسليم الواحد`, 400);
			stored.push(url);
		}
	}

	if (stored.length === 0) throw new AppError('أرفق ملفاً واحداً على الأقل أو أضف رابط تسليم https', 400);
	return stored;
}

function decodeName(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'ملف مرفق');
	} catch {
		return 'ملف مرفق';
	}
}
