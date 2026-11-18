// Local, deterministic safety scan for every uploaded file (no network, no AI). Runs inside uploadCloudFile, the single choke point of all uploads.
// It refuses what is dangerous whatever the file is called or declared as: native executables, Office macros, archives that are bombs or
// carry Windows executables / path-traversal names, and PDFs that launch programs or run script.
import { AppError } from './app-error';

export const SCAN_MAX_ZIP_ENTRIES = 2000;
export const SCAN_MAX_ZIP_UNCOMPRESSED = 1024 * 1024 * 1024; // declared total, 1 GiB
const EXECUTABLE_EXT = new Set(['exe', 'dll', 'scr', 'msi', 'msp', 'com', 'bat', 'cmd', 'vbs', 'vbe', 'wsf', 'jar', 'lnk', 'hta', 'cpl', 'pif']);

export type ScanVerdict = { ok: true } | { ok: false; reason: 'EXECUTABLE' | 'OFFICE_MACRO' | 'ARCHIVE_BOMB' | 'ARCHIVE_EXECUTABLE' | 'ARCHIVE_UNSAFE_PATH' | 'ARCHIVE_TOO_MANY_ENTRIES' | 'PDF_ACTIVE_CONTENT' };

const MESSAGES: Record<string, string> = {
	EXECUTABLE: 'الملفات التنفيذية غير مسموح برفعها',
	OFFICE_MACRO: 'ملفات Office التي تحتوي على ماكرو غير مسموح برفعها',
	ARCHIVE_BOMB: 'الأرشيف يعلن حجماً غير معقول بعد فك الضغط',
	ARCHIVE_EXECUTABLE: 'الأرشيف يحتوي على ملف تنفيذي (exe/dll/bat/…) وهو غير مسموح',
	ARCHIVE_UNSAFE_PATH: 'الأرشيف يحتوي على مسار ملف غير آمن',
	ARCHIVE_TOO_MANY_ENTRIES: 'الأرشيف يحتوي على عدد ملفات أكبر من المسموح',
	PDF_ACTIVE_CONTENT: 'ملف PDF يحتوي على سكربت أو أمر تشغيل وهو غير مسموح'
};

const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);

function isNativeExecutable(buf: Buffer): boolean {
	if (buf.length < 4) return false;
	if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
	const magic = buf.readUInt32BE(0);
	if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true; // Mach-O / fat / Java class
	if (buf[0] === 0x4d && buf[1] === 0x5a && buf.length >= 0x40) { // MZ + a real PE header
		const pe = u32(buf, 0x3c);
		return pe > 0 && pe + 4 <= buf.length && buf.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0]));
	}
	return false;
}

function scanZip(buf: Buffer): ScanVerdict | null {
	const from = Math.max(0, buf.length - 65557);
	let eocd = -1;
	for (let i = buf.length - 22; i >= from; i--) if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) return null; // not a (complete) zip: nothing to inspect
	const count = u16(buf, eocd + 10);
	let offset = u32(buf, eocd + 16);
	if (count > SCAN_MAX_ZIP_ENTRIES) return { ok: false, reason: 'ARCHIVE_TOO_MANY_ENTRIES' };
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (offset + 46 > buf.length || u32(buf, offset) !== 0x02014b50) break;
		total += u32(buf, offset + 24);
		const nameLen = u16(buf, offset + 28), extraLen = u16(buf, offset + 30), commentLen = u16(buf, offset + 32);
		const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
		if (name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name)) return { ok: false, reason: 'ARCHIVE_UNSAFE_PATH' };
		const lower = name.toLowerCase();
		if (lower.endsWith('vbaproject.bin') || lower.includes('/macrosheets/')) return { ok: false, reason: 'OFFICE_MACRO' };
		const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
		if (EXECUTABLE_EXT.has(ext)) return { ok: false, reason: 'ARCHIVE_EXECUTABLE' };
		offset += 46 + nameLen + extraLen + commentLen;
	}
	if (total > SCAN_MAX_ZIP_UNCOMPRESSED) return { ok: false, reason: 'ARCHIVE_BOMB' };
	return null;
}

export function scanAttachment(buf: Buffer): ScanVerdict {
	if (isNativeExecutable(buf)) return { ok: false, reason: 'EXECUTABLE' };
	if (buf.length >= 4 && u32(buf, 0) === 0x04034b50) { const zip = scanZip(buf); if (zip) return zip; }
	// Legacy Office (OLE2) with a VBA project = macros.
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) && buf.includes(Buffer.from('_VBA_PROJECT', 'utf16le'))) return { ok: false, reason: 'OFFICE_MACRO' };
	if (buf.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
		const text = buf.toString('latin1');
		if (/\/Launch\b|\/JavaScript\b|\/JS\b/.test(text)) return { ok: false, reason: 'PDF_ACTIVE_CONTENT' };
	}
	return { ok: true };
}

/** Throws a 422 AppError (Arabic message) when the file is unsafe. */
export function assertAttachmentSafe(buf: Buffer): void {
	const verdict = scanAttachment(buf);
	if (!verdict.ok) throw new AppError(MESSAGES[verdict.reason], 422);
}
