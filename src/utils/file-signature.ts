// Magic-byte check for uploads. The mime type a client declares (multer's file.mimetype, or the "data:" header) can be forged;
// the first bytes of the file cannot be, so for the types we can recognise the content must agree with the declared type.

export type DetectedFileKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf';

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

export function detectFileKind(buf: Buffer): DetectedFileKind | null {
	if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
	if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'gif';
	if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
	// %PDF- may be preceded by a few junk bytes in the wild; the spec allows it within the first 1024 bytes.
	if (buf.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
	return null;
}

const KIND_BY_MIME: Record<string, DetectedFileKind> = {
	'image/png': 'png',
	'image/jpeg': 'jpeg',
	'image/jpg': 'jpeg',
	'image/pjpeg': 'jpeg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'application/pdf': 'pdf'
};

/** The kind a declared mime type claims, or null when it is a type we cannot verify from bytes (docx, audio, video, octet-stream ...). */
export function declaredKind(mimeType: string): DetectedFileKind | null {
	return KIND_BY_MIME[mimeType.toLowerCase().split(';')[0].trim()] ?? null;
}

/** true when the content is consistent with the declared type (or the declared type is one we cannot verify). */
export function contentMatchesDeclaredType(buf: Buffer, mimeType: string): boolean {
	const expected = declaredKind(mimeType);
	if (!expected) return true;
	return detectFileKind(buf) === expected;
}
