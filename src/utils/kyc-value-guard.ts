import { AppError } from './app-error';
import { ownCloudinaryUrlProblem } from './cloudinary-url';

/**
 * KYC / identity / certificate fields accept only (a) a data: URI that the server then uploads itself, or (b) a URL that already points
 * into OUR Cloudinary account (a previously stored value echoed back). Any other string, in particular an external link, is refused.
 */
export function assertKycFileValue(value: unknown): void {
	if (value === undefined || value === null || value === '') return;
	if (typeof value !== 'string') throw new AppError('قيمة الملف غير صالحة', 400);
	if (value.startsWith('data:')) {
		// ID photos / documents / certificates: png, jpeg, webp or pdf only (the server also verifies the bytes when it uploads them).
		if (!/^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,/i.test(value)) throw new AppError('نوع الملف غير مسموح به؛ ارفع صورة PNG أو JPG أو WEBP أو ملف PDF', 400);
		return;
	}
	const problem = ownCloudinaryUrlProblem(value);
	if (problem) throw new AppError(problem, 400);
}

export function assertKycFileValues(values: unknown[]): void {
	for (const v of values) assertKycFileValue(v);
}
