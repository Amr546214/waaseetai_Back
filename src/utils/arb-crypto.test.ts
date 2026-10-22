import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptTrandata, encryptTrandata, javaUrlDecode, javaUrlEncode } from './arb-crypto';

// Known-answer vectors were produced by an INDEPENDENT implementation (openssl CLI, not Node):
//   printf '%s' '<java-url-encoded plain>' | openssl enc -aes-128-cbc -K <hex(key)> -iv <hex("PGKEYENCDECIVSPC")> | xxd -p | tr a-f A-F
// Guide v1.32: AES/CBC/PKCS5Padding, IV PGKEYENCDECIVSPC (p.20, p.266), URL-encode before encrypt (p.267), upper-case hex (p.267).
const KEY = '0123456789ABCDEF';

test('encrypt matches the openssl known answers (guide p.20 / p.266-267)', () => {
	assert.equal(
		encryptTrandata('[{"amt":"12.00","action":"1"}]', KEY),
		'1223AAF13222BDD6741DAE66AB6D87C2C494D817ECB4180C11B9ABC30E5B350151FBB93E51162BD693AB0D602083F436766094435A7AA1C9C7FA39350FC6BCCD',
	);
	assert.equal(encryptTrandata('abc', KEY), 'BC5160253D58C5EADC3172DF904C6F2B');
});

test('decrypt is the exact inverse, for 16 / 24 / 32 byte keys and Arabic / symbols', () => {
	const plain = JSON.stringify([{ amt: '12.00', msg: 'دفع + بطاقة *~() & = ?', password: 'q@a68O$27@JLkcK' }]);
	for (const key of ['0123456789ABCDEF', '0123456789ABCDEF01234567', '0123456789ABCDEF0123456789ABCDEF']) {
		const hex = encryptTrandata(plain, key);
		assert.match(hex, /^[0-9A-F]+$/);
		assert.equal(hex.length % 32, 0);
		assert.equal(decryptTrandata(hex, key), plain);
	}
});

test('java URLEncoder semantics: space is +, only A-Za-z0-9 . - * _ stay, everything else is upper-case %XX (UTF-8)', () => {
	assert.equal(javaUrlEncode('a b'), 'a+b');
	assert.equal(javaUrlEncode('a.b-c*d_e'), 'a.b-c*d_e');
	assert.equal(javaUrlEncode('~!()\'"'), '%7E%21%28%29%27%22');
	assert.equal(javaUrlEncode('é'), '%C3%A9');
	assert.equal(javaUrlDecode('a+b%C3%A9%2B'), 'a bé+');
	assert.throws(() => javaUrlDecode('%zz'));
});

test('bad input never decrypts to garbage: wrong key, bad hex, truncated block, tampered bytes all throw', () => {
	const hex = encryptTrandata('[{"amt":"1.00"}]', KEY);
	assert.throws(() => decryptTrandata(hex, 'FEDCBA9876543210'));
	assert.throws(() => decryptTrandata('xyz', KEY));
	assert.throws(() => decryptTrandata(hex.slice(0, hex.length - 2), KEY));
	assert.throws(() => decryptTrandata('', KEY));
	assert.throws(() => encryptTrandata('x', 'short'));
	const tampered = hex.slice(0, 10) + (hex[10] === '0' ? '1' : '0') + hex.slice(11);
	assert.throws(() => JSON.parse(decryptTrandata(tampered, KEY)));
});
