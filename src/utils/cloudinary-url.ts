// Pure URL checks (no Cloudinary SDK, no network): which URLs we accept as "already stored in OUR Cloudinary account".

/** true only for https://res.cloudinary.com/<our cloud name>/... — no other host, no other account, no credentials/port, no IP literal. */
export function isOwnCloudinaryUrl(value: string, cloudName = process.env.CLOUDINARY_CLOUD_NAME): boolean {
	if (!cloudName) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	if (url.username || url.password) return false;
	if (url.port && url.port !== '443') return false;
	if (url.hostname !== 'res.cloudinary.com') return false;
	return url.pathname.startsWith(`/${cloudName}/`);
}

/** The same URL shapes, but explaining why one is refused (Arabic, 400-ready). */
export function ownCloudinaryUrlProblem(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'رابط الملف غير صالح';
	}
	if (url.protocol !== 'https:') return 'يجب أن يكون رابط الملف آمناً HTTPS';
	if (!isOwnCloudinaryUrl(value)) return 'رابط الملف غير مسموح به؛ ارفع الملف مباشرة من الجهاز';
	return null;
}
