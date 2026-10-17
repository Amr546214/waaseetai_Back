import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import { globalErrorHandler } from './error.middleware';
import { AppError } from '../utils/app-error';
import { memoryUpload } from '../utils/cloudinary-storage';

// #40 — library errors that are the caller's mistake are 4xx with a fixed Arabic message, never a 500 "Internal Server Error".
function run(err: any) {
	const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
	globalErrorHandler(err, { method: 'POST', url: '/x' } as any, res, () => {});
	return res;
}
const ARABIC = /[؀-ۿ]/;

test('Prisma P2002 → 409 Arabic, P2025 → 404 Arabic; nothing from the error (target / SQL) is echoed', () => {
	const dup = run(Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002', meta: { target: ['email'] } }));
	assert.equal(dup.statusCode, 409); assert.match(dup.body.message, ARABIC); assert.doesNotMatch(JSON.stringify(dup.body), /email|Unique|constraint/i);
	const nf = run(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));
	assert.equal(nf.statusCode, 404); assert.match(nf.body.message, ARABIC); assert.doesNotMatch(JSON.stringify(nf.body), /Record|update/i);
});

test('body-parser: malformed JSON → 400, too large → 413, unsupported encoding → 415', () => {
	assert.equal(run(Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 })).statusCode, 400);
	assert.equal(run(Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 })).statusCode, 413);
	assert.equal(run(Object.assign(new Error('enc'), { type: 'encoding.unsupported', status: 415 })).statusCode, 415);
});

test('Multer: size → 413, count / unexpected field → 400, other → 400', () => {
	const m = (code: string) => run(Object.assign(new multer.MulterError(code as any), {}));
	assert.equal(m('LIMIT_FILE_SIZE').statusCode, 413);
	assert.equal(m('LIMIT_FILE_COUNT').statusCode, 400);
	assert.equal(m('LIMIT_UNEXPECTED_FILE').statusCode, 400);
	assert.equal(m('LIMIT_PART_COUNT').statusCode, 400);
	assert.match(m('LIMIT_FILE_SIZE').body.message, ARABIC);
});

test('AppError and unknown errors behave as before (status kept; unknown → 500 generic)', () => {
	const a = run(new AppError('ممنوع', 403)); assert.equal(a.statusCode, 403); assert.equal(a.body.message, 'ممنوع');
	const u = run(new Error('boom')); assert.equal(u.statusCode, 500); assert.equal(u.body.message, 'Internal Server Error');
});

async function call(app: express.Express, path: string, init: { body?: any; headers?: Record<string, string>; method?: string }) {
	const server = http.createServer(app).listen(0);
	try {
		const port = (server.address() as any).port;
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'POST', headers: init.headers, body: init.body });
		return { status: r.status, body: await r.json() };
	} finally { server.close(); }
}

test('end to end: bad JSON body is a 400, an oversize / wrong-type upload is 413 / 415 (real express + multer)', async () => {
	const app = express();
	app.use(express.json({ limit: '1kb' }));
	const up = memoryUpload({ fileSize: 10, files: 1, allowedMimeTypes: new Set(['image/png']) });
	app.post('/json', (_req, res) => { res.json({ ok: true }); });
	app.post('/upload', up.single('file'), (_req, res) => { res.json({ ok: true }); });
	app.use(globalErrorHandler);

	assert.equal((await call(app, '/json', { body: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
	assert.equal((await call(app, '/json', { body: JSON.stringify({ a: 'x'.repeat(5000) }), headers: { 'content-type': 'application/json' } })).status, 413);

	const form = (type: string, size: number) => { const f = new FormData(); f.append('file', new Blob(['x'.repeat(size)], { type }), 'a.bin'); return f; };
	assert.equal((await call(app, '/upload', { body: form('image/png', 1000) })).status, 413);
	assert.equal((await call(app, '/upload', { body: form('text/html', 5) })).status, 415);
	assert.equal((await call(app, '/upload', { body: form('image/png', 5) })).status, 200);
});

test('PayPal-email freeze error: the handler forwards the fixed code plus availableAt / retryAfterSeconds (and nothing else extra)', async () => {
	const { paypalEmailFrozenError } = await import('../utils/paypal-email-messages');
	const until = new Date(Date.now() + 3600_000);
	const e = Object.assign(paypalEmailFrozenError(AppError, until), { secret: 'x' });
	const r = run(e);
	assert.equal(r.statusCode, 400);
	assert.equal(r.body.code, 'PAYPAL_EMAIL_FROZEN');
	assert.equal(r.body.availableAt, until.toISOString());
	assert.ok(r.body.retryAfterSeconds > 3500 && r.body.retryAfterSeconds <= 3600);
	assert.equal('secret' in r.body, false);
});

test('OTP request errors: the throttle forwards code + retryAfterSeconds; the failed-mail error forwards its fixed code only', () => {
	const t = run(Object.assign(new AppError('انتظر قليلًا', 429), { code: 'OTP_THROTTLED', retryAfterSeconds: 42, secret: 'x' }));
	assert.equal(t.statusCode, 429); assert.equal(t.body.code, 'OTP_THROTTLED'); assert.equal(t.body.retryAfterSeconds, 42); assert.equal('secret' in t.body, false);
	const m = run(Object.assign(new AppError('تعذر إرسال رمز التحقق، حاول مرة أخرى', 503), { code: 'PAYPAL_OTP_EMAIL_FAILED', smtp: 'details' }));
	assert.equal(m.statusCode, 503); assert.equal(m.body.code, 'PAYPAL_OTP_EMAIL_FAILED'); assert.equal('smtp' in m.body, false);
});

// Countdown: every 429 / 423 wait says how long in machine-readable form (header + retryAfterSeconds + retryAt); a lock by wrong attempts invents no duration.
function runWithHeaders(err: any, preset: Record<string, string> = {}) {
	const headers: Record<string, string> = { ...preset };
	const res: any = { statusCode: 0, body: null, headers, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; }, getHeader: (k: string) => headers[k], setHeader: (k: string, v: string) => { headers[k] = v; } };
	globalErrorHandler(err, { method: 'POST', url: '/x' } as any, res, () => {});
	return res;
}

test('429 with errors[].retryAfterSeconds and no header: Retry-After + retryAfterSeconds + retryAt are added; message and status stay', () => {
	const before = Date.now();
	const r = runWithHeaders(new AppError('طلبات رمز التوقيع كثيرة. انتظر دقيقة ثم حاول مجدداً', 429, [{ code: 'SIGN_OTP_THROTTLED', retryAfterSeconds: 42 }]));
	assert.equal(r.statusCode, 429); assert.equal(r.headers['Retry-After'], '42'); assert.equal(r.body.retryAfterSeconds, 42);
	assert.equal(r.body.message, 'طلبات رمز التوقيع كثيرة. انتظر دقيقة ثم حاول مجدداً');
	const at = Date.parse(r.body.retryAt); assert.ok(at >= before + 42_000 - 1000 && at <= Date.now() + 42_000 + 1000);
});

test('429 whose limiter already set Retry-After: the header is kept and mirrored into the body', () => {
	const r = runWithHeaders(new AppError('محاولات كثيرة', 429), { 'Retry-After': '90' });
	assert.equal(r.headers['Retry-After'], '90'); assert.equal(r.body.retryAfterSeconds, 90);
});

test('423 with a duration gets the header too; a 429/423 without any duration gets NO invented seconds', () => {
	const r = runWithHeaders(Object.assign(new AppError('مجمّد', 423), { retryAfterSeconds: 5 }));
	assert.equal(r.headers['Retry-After'], '5');
	const n = runWithHeaders(new AppError('محاولات كثيرة', 429));
	assert.equal(n.headers['Retry-After'], undefined); assert.equal('retryAfterSeconds' in n.body, false); assert.equal('retryAt' in n.body, false);
});

test('OTP attempts lock (429) carries a stable code and no duration; other statuses never get Retry-After', () => {
	const l = runWithHeaders(new AppError('تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد', 429));
	assert.equal(l.body.code, 'OTP_ATTEMPTS_LOCKED'); assert.equal(l.headers['Retry-After'], undefined);
	const b = runWithHeaders(Object.assign(new AppError('x', 400), { retryAfterSeconds: 9 }));
	assert.equal(b.headers['Retry-After'], undefined);
});
