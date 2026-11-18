import test from 'node:test';
import assert from 'node:assert/strict';
import { scanAttachment, assertAttachmentSafe, SCAN_MAX_ZIP_ENTRIES } from './attachment-scan';

function zip(entries: Array<{ name: string; size?: number }>): Buffer {
	const parts: Buffer[] = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)];
	const cds: Buffer[] = [];
	for (const e of entries) {
		const name = Buffer.from(e.name);
		const cd = Buffer.alloc(46 + name.length);
		cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(e.size ?? 10, 24); cd.writeUInt16LE(name.length, 28); name.copy(cd, 46);
		cds.push(cd);
	}
	const cdBuf = Buffer.concat(cds), head = Buffer.concat(parts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(head.length, 16);
	return Buffer.concat([head, cdBuf, eocd]);
}
const reason = (b: Buffer) => { const v = scanAttachment(b); return v.ok ? 'OK' : v.reason; };

test('plain images / text / pdf pass', () => {
	assert.equal(reason(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), 'OK');
	assert.equal(reason(Buffer.from('MZ just some text that starts with MZ')), 'OK');
	assert.equal(reason(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Page >> endobj')), 'OK');
});
test('native executables are refused', () => {
	assert.equal(reason(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), 'EXECUTABLE');
	assert.equal(reason(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])), 'EXECUTABLE');
	const pe = Buffer.alloc(0x100); pe[0] = 0x4d; pe[1] = 0x5a; pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\0\0', 0x80, 'latin1');
	assert.equal(reason(pe), 'EXECUTABLE');
});
test('zip: clean archive passes; exe, traversal, macros, bombs, too many entries are refused', () => {
	assert.equal(reason(zip([{ name: 'src/app.ts' }, { name: 'readme.md' }, { name: 'run.sh' }])), 'OK');
	assert.equal(reason(zip([{ name: 'setup.EXE' }])), 'ARCHIVE_EXECUTABLE');
	assert.equal(reason(zip([{ name: '../../etc/passwd' }])), 'ARCHIVE_UNSAFE_PATH');
	assert.equal(reason(zip([{ name: 'C:\\win\\x.txt' }])), 'ARCHIVE_UNSAFE_PATH');
	assert.equal(reason(zip([{ name: 'word/vbaProject.bin' }])), 'OFFICE_MACRO');
	assert.equal(reason(zip([{ name: 'a.bin', size: 600 * 1024 * 1024 }, { name: 'b.bin', size: 600 * 1024 * 1024 }])), 'ARCHIVE_BOMB');
	assert.equal(reason(zip(Array.from({ length: SCAN_MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt` })))), 'ARCHIVE_TOO_MANY_ENTRIES');
});
test('legacy Office with a VBA project and PDFs with script/launch are refused', () => {
	const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40), Buffer.from('_VBA_PROJECT', 'utf16le')]);
	assert.equal(reason(ole), 'OFFICE_MACRO');
	assert.equal(reason(Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>')), 'PDF_ACTIVE_CONTENT');
	assert.equal(reason(Buffer.from('%PDF-1.4\n<< /S /Launch /F (cmd.exe) >>')), 'PDF_ACTIVE_CONTENT');
});
test('assertAttachmentSafe throws a 422 with an Arabic message', () => {
	assert.throws(() => assertAttachmentSafe(zip([{ name: 'x.dll' }])), (e: any) => e.statusCode === 422 && /تنفيذي/.test(e.message));
	assert.doesNotThrow(() => assertAttachmentSafe(Buffer.from('hello')));
});
