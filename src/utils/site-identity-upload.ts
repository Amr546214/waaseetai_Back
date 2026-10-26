import { createHash } from 'node:crypto';
import { AppError } from './app-error';
import { detectFileKind } from './file-signature';
import { sanitizeSvg, SvgRejected } from './svg-sanitizer';
import { ABSOLUTE_MAX_PIXELS, ABSOLUTE_MAX_SIDE, SiteIdentityKeyDef, maxBytesFor } from '../config/site-identity.registry';

/**
 * Validation of a site-identity upload. The decision is made from the BYTES: magic numbers (never the extension or the Content-Type alone), the real size, the real dimensions read from the image header
 * (PNG / JPEG / WebP / ICO parsed here, SVG from its viewBox), structural integrity (a truncated or padded file is refused), and a registry rule per key. An SVG is sanitised (see svg-sanitizer.ts);
 * a raster / ico is NEVER re-encoded or "repaired": it is either exactly what the admin sent or it is rejected.
 */

export const IDENTITY_FILE_REJECTED = 'SITE_IDENTITY_FILE_REJECTED';
export class UploadRejected extends AppError {
	constructor(message: string, public readonly reason: string, status = 400) { super(message, status, [{ field: 'file', message, reason }], IDENTITY_FILE_REJECTED); }
}

export type SniffedKind = 'png' | 'jpeg' | 'webp' | 'ico' | 'svg';
export const MIME_BY_KIND: Record<SniffedKind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
const KIND_NAMES: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/svg+xml': 'SVG', 'image/x-icon': 'ICO' };

export interface ValidatedUpload {
	mime: string; bytes: Buffer; sha256: string; byteSize: number; width: number | null; height: number | null;
	/** what the sanitiser changed (staged row note), null when nothing */
	note: string | null; sanitized: { changed: boolean; removed: number };
}

export const sha256Of = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------- CRC32 (PNG chunks)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer, start: number, end: number): number => { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// ---------------------------------------------------------------------------------------------------- sniffing
const isIco = (b: Buffer): boolean => b.length >= 22 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) >= 1 && b.readUInt16LE(4) <= 64;

/** the real kind of the bytes, or null when they are none of the five allowed families */
export function sniffKind(buf: Buffer): SniffedKind | 'gif' | 'pdf' | 'markup' | null {
	const k = detectFileKind(buf);
	if (k === 'png' || k === 'jpeg' || k === 'webp') return k;
	if (k === 'gif' || k === 'pdf') return k;
	if (isIco(buf)) return 'ico';
	// text starting with "<": an SVG may carry a BOM / whitespace / an xml prolog / a doctype / comments before <svg; anything else (HTML, PHP, a script, other XML) is "markup" and is refused
	const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
	if (head.startsWith('<')) {
		const stripped = head.replace(/^(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>\s*)*/i, '');
		return /^<svg[\s>/]/i.test(stripped) ? 'svg' : 'markup';
	}
	return null;
}

// Words that have no business inside a bitmap: a polyglot (an image that is also a page / script) is refused, whatever its header says.
const POLYGLOT_MARKERS = [/<\s*script/i, /<\s*html/i, /<\s*iframe/i, /<\s*svg/i, /<\?php/i, /javascript\s*:/i, /<\s*body/i, /onerror\s*=/i, /onload\s*=/i, /<!DOCTYPE/i];
function assertNoPolyglot(buf: Buffer): void {
	const text = buf.toString('latin1');
	for (const re of POLYGLOT_MARKERS) if (re.test(text)) throw new UploadRejected('الملف يحتوي نصًا برمجيًا أو صفحة مضمّنة داخل الصورة، وهذا غير مسموح.', 'POLYGLOT');
}

interface Parsed { width: number; height: number }
const truncated = () => new UploadRejected('الملف تالف أو ناقص (الصورة مقطوعة قبل نهايتها).', 'TRUNCATED');
const trailing = () => new UploadRejected('الملف يحتوي بيانات إضافية بعد نهاية الصورة، وهذا غير مسموح.', 'TRAILING_DATA');
const bad = (reason: string, msg = 'بنية الصورة غير صالحة.') => new UploadRejected(msg, reason);

export function parsePng(b: Buffer): Parsed {
	if (b.length < 8 + 25 + 12) throw truncated();
	let off = 8; let width = 0, height = 0; let sawIdat = false, sawEnd = false; let first = true;
	while (off < b.length) {
		if (off + 12 > b.length) throw truncated();
		const len = b.readUInt32BE(off); const type = b.toString('latin1', off + 4, off + 8);
		if (len > 0x7fffffff || off + 12 + len > b.length) throw truncated();
		if (!/^[A-Za-z]{4}$/.test(type)) throw bad('PNG_CHUNK_TYPE');
		const crc = b.readUInt32BE(off + 8 + len);
		if (crc32(b, off + 4, off + 8 + len) !== crc) throw bad('PNG_CRC', 'الملف تالف: فشل التحقق من سلامة الصورة (CRC).');
		if (first) { if (type !== 'IHDR' || len !== 13) throw bad('PNG_IHDR'); width = b.readUInt32BE(off + 8); height = b.readUInt32BE(off + 12); first = false; }
		else if (type === 'IHDR') throw bad('PNG_IHDR_TWICE');
		if (type === 'IDAT') sawIdat = true;
		if (type === 'acTL') throw new UploadRejected('صور PNG المتحركة (APNG) غير مسموحة.', 'ANIMATED');
		off += 12 + len;
		if (type === 'IEND') { sawEnd = true; break; }
	}
	if (!sawEnd || !sawIdat) throw truncated();
	if (off !== b.length) throw trailing();
	if (!width || !height) throw bad('PNG_ZERO_DIMENSIONS');
	return { width, height };
}

export function parseJpeg(b: Buffer): Parsed {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw bad('JPEG_SOI');
	let off = 2; let dims: Parsed | null = null;
	while (off < b.length) {
		if (b[off] !== 0xff) throw bad('JPEG_MARKER', 'بنية صورة JPEG غير صالحة.');
		while (off < b.length && b[off] === 0xff) off++;
		const m = b[off++];
		if (m === undefined) throw truncated();
		if (m === 0xd9) { if (!dims) throw bad('JPEG_NO_SOF'); if (off !== b.length) throw trailing(); return dims; }
		if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue; // markers without a length
		if (off + 2 > b.length) throw truncated();
		const len = b.readUInt16BE(off); if (len < 2 || off + len > b.length) throw truncated();
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			if (len < 8) throw bad('JPEG_SOF');
			dims = { height: b.readUInt16BE(off + 3), width: b.readUInt16BE(off + 5) };
		}
		off += len;
		if (m === 0xda) { // entropy-coded data up to the next real marker
			while (off < b.length) { if (b[off] === 0xff && b[off + 1] !== 0x00 && !(b[off + 1] >= 0xd0 && b[off + 1] <= 0xd7) && b[off + 1] !== 0xff) break; off++; }
		}
	}
	throw truncated(); // never met EOI
}

export function parseWebp(b: Buffer): Parsed {
	if (b.length < 21) throw truncated();
	const riff = b.readUInt32LE(4);
	if (riff + 8 > b.length) throw truncated();
	if (riff + 8 < b.length) throw trailing();
	const fourcc = b.toString('latin1', 12, 16); const size = b.readUInt32LE(16);
	if (20 + size > b.length) throw truncated();
	const need = (n: number) => { if (b.length < n || size < n - 20) throw truncated(); };
	if (fourcc === 'VP8X') {
		need(30);
		if (b[20] & 0x02) throw new UploadRejected('صور WebP المتحركة غير مسموحة.', 'ANIMATED');
		return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
	}
	if (fourcc === 'VP8 ') {
		need(30);
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw bad('WEBP_VP8');
		return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	}
	if (fourcc === 'VP8L') {
		need(25);
		if (b[20] !== 0x2f) throw bad('WEBP_VP8L');
		const bits = b.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	throw bad('WEBP_CHUNK', 'بنية صورة WebP غير مدعومة.');
}

export function parseIco(b: Buffer): Parsed {
	const count = b.readUInt16LE(4);
	if (count < 1 || count > 16) throw bad('ICO_COUNT', 'ملف ICO يحتوي عددًا غير مقبول من الصور.');
	const dirEnd = 6 + count * 16; if (dirEnd > b.length) throw truncated();
	let best: Parsed = { width: 0, height: 0 }; let end = dirEnd;
	for (let i = 0; i < count; i++) {
		const e = 6 + i * 16; const w = b[e] || 256, h = b[e + 1] || 256; const size = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
		if (off < dirEnd || size < 8 || off + size > b.length) throw truncated();
		const png = b.subarray(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		if (png) { try { parsePng(b.subarray(off, off + size)); } catch (err) { throw err instanceof UploadRejected ? err : bad('ICO_PNG'); } }
		else if (b.readUInt32LE(off) !== 40) throw bad('ICO_IMAGE', 'إحدى صور ملف ICO بصيغة غير مدعومة.');
		end = Math.max(end, off + size);
		if (w * h > best.width * best.height) best = { width: w, height: h };
	}
	if (end < b.length) throw trailing();
	return best;
}

function assertDimensions(def: SiteIdentityKeyDef, mime: string, width: number | null, height: number | null): void {
	const d = def.dimensions; const isSvg = mime === 'image/svg+xml';
	if (width === null || height === null || !(width > 0) || !(height > 0)) throw new UploadRejected(isSvg ? 'ملف SVG بلا مقاس معروف: أضف viewBox (مثل viewBox="0 0 24 24") أو width و height.' : 'تعذّرت قراءة مقاس الصورة.', 'NO_DIMENSIONS');
	if (!isSvg) {
		if (width > ABSOLUTE_MAX_SIDE || height > ABSOLUTE_MAX_SIDE || width * height > ABSOLUTE_MAX_PIXELS) throw new UploadRejected(`مقاس الصورة (${width}×${height}) كبير جدًا.`, 'DIMENSIONS_TOO_LARGE');
	}
	const label = `${Math.round(width)}×${Math.round(height)}`;
	if (d.exact) {
		if (isSvg || width !== d.exact.width || height !== d.exact.height) throw new UploadRejected(`مقاس الصورة (${label}) غير مطابق للمطلوب بالضبط: ${d.exact.width}×${d.exact.height}.`, 'WRONG_DIMENSIONS');
		return;
	}
	if (!isSvg) {
		if ((d.minWidth && width < d.minWidth) || (d.minHeight && height < d.minHeight)) throw new UploadRejected(`الصورة (${label}) أصغر من الحد الأدنى ${d.minWidth ?? 1}×${d.minHeight ?? 1}.`, 'TOO_SMALL');
		if ((d.maxWidth && width > d.maxWidth) || (d.maxHeight && height > d.maxHeight)) throw new UploadRejected(`الصورة (${label}) أكبر من الحد الأقصى ${d.maxWidth ?? ABSOLUTE_MAX_SIDE}×${d.maxHeight ?? ABSOLUTE_MAX_SIDE}.`, 'TOO_LARGE_DIMENSIONS');
	}
	const aspect = width / height;
	if ((d.aspectMin !== undefined && aspect < d.aspectMin - 1e-9) || (d.aspectMax !== undefined && aspect > d.aspectMax + 1e-9)) {
		const square = d.aspectMin !== undefined && d.aspectMax !== undefined && d.aspectMax - d.aspectMin <= 0.02;
		throw new UploadRejected(square ? `يجب أن تكون الصورة مربّعة (الحالية ${label}).` : `نسبة العرض إلى الارتفاع (${aspect.toFixed(2)}) خارج المسموح (${d.aspectMin ?? 0} – ${d.aspectMax ?? '∞'}).`, 'WRONG_ASPECT');
	}
}

/** Validates (and, for SVG, sanitises) an upload against the registry rules of its key. Throws UploadRejected / SvgRejected (both 400 with code SITE_IDENTITY_FILE_REJECTED). */
export async function validateIdentityUpload(def: SiteIdentityKeyDef, input: Buffer, declaredMime?: string): Promise<ValidatedUpload> {
	if (!input || input.length === 0) throw new UploadRejected('الملف فارغ.', 'EMPTY');
	const ceiling = Math.max(def.maxBytes, 1);
	if (input.length > ceiling) throw new UploadRejected(`حجم الملف (${Math.round(input.length / 1024)}KB) أكبر من الحد المسموح لهذا العنصر (${Math.round(ceiling / 1024)}KB).`, 'TOO_BIG', 413);
	const kind = sniffKind(input);
	if (kind === null) throw new UploadRejected('نوع الملف غير مدعوم: المحتوى ليس صورة PNG أو JPEG أو WebP أو ICO أو SVG.', 'UNSUPPORTED_TYPE');
	if (kind === 'gif') throw new UploadRejected('صور GIF غير مسموحة.', 'UNSUPPORTED_TYPE');
	if (kind === 'pdf') throw new UploadRejected('ملفات PDF غير مسموحة.', 'UNSUPPORTED_TYPE');
	if (kind === 'markup') throw new UploadRejected('الملف نصّ HTML / XML وليس صورة أو SVG صالحًا.', 'MARKUP_NOT_SVG');
	const mime = MIME_BY_KIND[kind];
	// a declared type that names a DIFFERENT image type than the bytes is a spoof; octet-stream / unknown declarations are ignored (the bytes decide)
	const declared = (declaredMime ?? '').toLowerCase().split(';')[0].trim().replace('image/vnd.microsoft.icon', 'image/x-icon').replace('image/jpg', 'image/jpeg').replace('image/pjpeg', 'image/jpeg');
	if (declared && KIND_NAMES[declared] && declared !== mime) throw new UploadRejected(`نوع الملف المعلن (${KIND_NAMES[declared]}) لا يطابق محتواه الفعلي (${KIND_NAMES[mime]}).`, 'MIME_MISMATCH');
	if (!def.allowedMimes.includes(mime)) throw new UploadRejected(`الصيغة ${KIND_NAMES[mime]} غير مسموحة لهذا العنصر. المسموح: ${def.allowedMimes.map(m => KIND_NAMES[m] ?? m).join('، ')}.`, 'FORMAT_NOT_ALLOWED');
	if (input.length > maxBytesFor(def, mime)) throw new UploadRejected(`حجم الملف (${Math.round(input.length / 1024)}KB) أكبر من الحد المسموح (${Math.round(maxBytesFor(def, mime) / 1024)}KB).`, 'TOO_BIG', 413);

	if (kind === 'svg') {
		const r = await sanitizeSvg(input);
		const out = Buffer.from(r.svg, 'utf8');
		if (out.length > maxBytesFor(def, mime)) throw new UploadRejected('حجم ملف SVG بعد التنظيف أكبر من الحد المسموح.', 'TOO_BIG', 413);
		assertDimensions(def, mime, r.width, r.height);
		return { mime, bytes: out, sha256: sha256Of(out), byteSize: out.length, width: r.width === null ? null : Math.round(r.width), height: r.height === null ? null : Math.round(r.height),
			note: r.changed ? `نُظِّف ملف SVG: أُزيل ${r.removed} عنصر/خاصية غير مسموحة (${r.removedDetail.slice(0, 6).join('؛ ')})` : null, sanitized: { changed: r.changed, removed: r.removed } };
	}

	assertNoPolyglot(input);
	const p = kind === 'png' ? parsePng(input) : kind === 'jpeg' ? parseJpeg(input) : kind === 'webp' ? parseWebp(input) : parseIco(input);
	assertDimensions(def, mime, p.width, p.height);
	return { mime, bytes: input, sha256: sha256Of(input), byteSize: input.length, width: p.width, height: p.height, note: null, sanitized: { changed: false, removed: 0 } };
}

export { SvgRejected };
