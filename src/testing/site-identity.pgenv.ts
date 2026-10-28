import zlib from 'node:zlib';

/** Real, parseable image files built in memory for the site-identity tests (PNG with correct CRCs, JPEG, WebP, ICO). Not compiled into the app (pgenv). */
export const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
/** a real PNG; `fakeW/fakeH` claim a size in IHDR while the pixel data stays tiny (decompression-bomb shape: the parser must refuse it without inflating anything) */
export const png = (w: number, h: number, o: { fakeW?: number; fakeH?: number; extra?: Buffer; noEnd?: boolean; text?: string } = {}) => {
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(o.fakeW ?? w, 0); ihdr.writeUInt32BE(o.fakeH ?? h, 4); ihdr[8] = 8; ihdr[9] = 6;
	const rows = o.fakeW || o.fakeH ? Buffer.alloc(8) : Buffer.alloc((w * 4 + 1) * h);
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
	if (o.text) parts.push(chunk('tEXt', Buffer.from(`k\0${o.text}`)));
	parts.push(chunk('IDAT', zlib.deflateSync(rows)));
	if (!o.noEnd) parts.push(chunk('IEND', Buffer.alloc(0)));
	if (o.extra) parts.push(o.extra);
	return Buffer.concat(parts);
};
export const jpeg = (w: number, h: number, o: { noEoi?: boolean; extra?: Buffer } = {}) => {
	const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3; [[1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]].forEach((c, i) => { sof[10 + i * 3] = c[0]; sof[11 + i * 3] = c[1]; sof[12 + i * 3] = c[2]; });
	const sos = Buffer.from([0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([1, 2, 3, 4, 5, 6, 0xff, 0x00, 7, 8]), o.noEoi ? Buffer.alloc(0) : Buffer.from([0xff, 0xd9]), o.extra ?? Buffer.alloc(0)]);
};
export const webpLossless = (w: number, h: number, o: { animated?: boolean; extra?: Buffer; cut?: number } = {}) => {
	const bits = Buffer.alloc(5); bits[0] = 0x2f; bits.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
	let body = Buffer.concat([Buffer.from('VP8L'), Buffer.from([bits.length + 4, 0, 0, 0]), bits, Buffer.alloc(4)]);
	if (o.animated) { const x = Buffer.alloc(10); x[0] = 0x02; x.writeUIntLE(w - 1, 4, 3); x.writeUIntLE(h - 1, 7, 3); body = Buffer.concat([Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), x]); body = Buffer.concat([body, Buffer.alloc(10)]); }
	const total = Buffer.alloc(4); total.writeUInt32LE(body.length + 4);
	let out = Buffer.concat([Buffer.from('RIFF'), total, Buffer.from('WEBP'), body, o.extra ?? Buffer.alloc(0)]);
	if (o.cut) out = out.subarray(0, out.length - o.cut);
	return out;
};
export const ico = (size: number, o: { entries?: number; extra?: Buffer } = {}) => {
	const n = o.entries ?? 1; const img = png(size, size); const dir = Buffer.alloc(6 + 16 * n); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(n, 4);
	for (let i = 0; i < n; i++) { dir[6 + i * 16] = size >= 256 ? 0 : size; dir[7 + i * 16] = size >= 256 ? 0 : size; dir.writeUInt32LE(img.length, 6 + i * 16 + 8); dir.writeUInt32LE(dir.length + i * img.length, 6 + i * 16 + 12); }
	return Buffer.concat([dir, ...Array.from({ length: n }, () => img), o.extra ?? Buffer.alloc(0)]);
};
