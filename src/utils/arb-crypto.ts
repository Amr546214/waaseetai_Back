import { createCipheriv, createDecipheriv } from 'crypto';

/**
 * ARB / Neoleap trandata encryption, exactly as the bank's REST guide v1.32 describes it:
 *  - AES, CBC mode, PKCS5/PKCS7 padding, IV = the 16 ASCII bytes "PGKEYENCDECIVSPC" (p.20, p.266-269)
 *  - the key is the merchant "Resource Key" used as UTF-8 bytes (16/24/32 bytes -> AES-128/192/256)
 *  - the plain JSON is URL-ENCODED (Java URLEncoder) BEFORE encryption and URL-DECODED after decryption (p.267 / p.268 notes)
 *  - the ciphertext is HEX, UPPER-CASE (p.267 `s.toUpperCase()`)
 * Pure functions: no I/O, no logging. The key never leaves the caller.
 */
export const ARB_IV = 'PGKEYENCDECIVSPC';

/** java.net.URLEncoder.encode(s, "UTF-8"): letters, digits and . - * _ stay; space -> "+"; everything else %XX (upper-case hex). */
export function javaUrlEncode(input: string): string {
	let out = '';
	for (const byte of Buffer.from(input, 'utf8')) {
		const c = String.fromCharCode(byte);
		if (/[A-Za-z0-9.\-*_]/.test(c)) out += c;
		else if (byte === 0x20) out += '+';
		else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
	}
	return out;
}

/** java.net.URLDecoder.decode(s, "UTF-8"): "+" -> space, %XX -> byte. A malformed escape throws. */
export function javaUrlDecode(input: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === '+') bytes.push(0x20);
		else if (ch === '%') {
			const hex = input.slice(i + 1, i + 3);
			if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error('malformed url-encoding');
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else {
			for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

function algorithmFor(key: string): string {
	const len = Buffer.byteLength(key, 'utf8');
	if (len === 16) return 'aes-128-cbc';
	if (len === 24) return 'aes-192-cbc';
	if (len === 32) return 'aes-256-cbc';
	throw new Error('ARB resource key must be 16, 24 or 32 bytes');
}

/** plain JSON text -> URL-encode -> AES-CBC -> upper-case hex (the `trandata` request field). */
export function encryptTrandata(plain: string, key: string): string {
	const cipher = createCipheriv(algorithmFor(key), Buffer.from(key, 'utf8'), Buffer.from(ARB_IV, 'utf8'));
	return Buffer.concat([cipher.update(Buffer.from(javaUrlEncode(plain), 'utf8')), cipher.final()]).toString('hex').toUpperCase();
}

/** hex `trandata` -> AES-CBC -> URL-decode -> plain JSON text. Throws on bad hex, bad padding or bad escapes (never returns garbage silently). */
export function decryptTrandata(hex: string, key: string): string {
	if (typeof hex !== 'string' || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length % 32 !== 0) throw new Error('trandata is not valid hex of whole AES blocks');
	const decipher = createDecipheriv(algorithmFor(key), Buffer.from(key, 'utf8'), Buffer.from(ARB_IV, 'utf8'));
	const encoded = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
	return javaUrlDecode(encoded);
}
