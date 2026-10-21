import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { safeServerErrors } from './safe-server-errors.middleware';
import { globalErrorHandler } from './error.middleware';
import { AppError } from '../utils/app-error';

const app = express();
app.use(safeServerErrors);
app.get('/raw-sql', (_req, res) => { res.status(500).json({ success: false, message: 'Invalid `prisma.user.findMany()` invocation: relation "users" does not exist' }); });
app.get('/raw-code', (_req, res) => { res.status(500).json({ success: false, message: 'SOME_INTERNAL_CODE' }); });
app.get('/arabic', (_req, res) => { res.status(503).json({ success: false, message: 'خدمة التحقق غير متاحة حاليًا، حاول لاحقًا', code: 'SERVICE_DOWN' }); });
app.get('/arabic-leaky', (_req, res) => { res.status(500).json({ success: false, message: 'فشل: relation "users" does not exist' }); });
app.get('/business', (_req, res) => { res.status(409).json({ success: false, message: 'INVALID_OR_EXPIRED_OTP' }); });
app.get('/health-degraded', (_req, res) => { res.status(503).json({ status: 'degraded', db: false }); });
app.get('/en-401', (_req, res) => { res.status(401).json({ success: false, message: 'Unauthorized' }); });
app.get('/en-404', (_req, res) => { res.status(404).json({ success: false, message: 'Provider not found' }); });
app.get('/en-403-code', (_req, res) => { res.status(403).json({ success: false, message: 'ROLE_MISMATCH', code: 'ROLE_MISMATCH' }); });
app.get('/ar-403', (_req, res) => { res.status(403).json({ success: false, message: 'هذا الحساب معطل حالياً، يرجى التواصل مع الدعم' }); });
app.get('/handled', (_req, _res, next) => next(new AppError('x', 500)));
app.use(globalErrorHandler);

async function get(path: string) {
	const server = http.createServer(app).listen(0);
	try {
		const port = (server.address() as any).port;
		const r = await fetch(`http://127.0.0.1:${port}${path}`);
		return { status: r.status, body: await r.json() as any };
	} finally { server.close(); }
}

test('a controller 5xx with a raw / SQL / code text is replaced by the honest fixed message, a code and a trace id', async () => {
	for (const p of ['/raw-sql', '/raw-code', '/arabic-leaky']) {
		const r = await get(p);
		assert.equal(r.status, 500); assert.equal(r.body.code, 'INTERNAL_ERROR'); assert.match(r.body.traceId, /^[0-9A-F]{8}$/);
		assert.match(r.body.message, /[؀-ۿ]/); assert.doesNotMatch(JSON.stringify(r.body), /prisma|relation|SOME_INTERNAL_CODE|users/);
	}
});
test('a deliberate Arabic 5xx explanation is kept (with its code and a trace id); 4xx business answers and non-error 5xx bodies are untouched', async () => {
	const a = await get('/arabic'); assert.equal(a.status, 503); assert.equal(a.body.message, 'خدمة التحقق غير متاحة حاليًا، حاول لاحقًا'); assert.equal(a.body.code, 'SERVICE_DOWN'); assert.match(a.body.traceId, /^[0-9A-F]{8}$/);
	const b = await get('/business'); assert.deepEqual(b.body, { success: false, message: 'INVALID_OR_EXPIRED_OTP' });
	const h = await get('/health-degraded'); assert.deepEqual(h.body, { status: 'degraded', db: false });
});
test('what the global error handler already answered is not rewritten a second time (one trace id)', async () => {
	const r = await get('/handled'); assert.equal(r.status, 500); assert.equal(r.body.code, 'INTERNAL_ERROR'); assert.match(r.body.traceId, /^[0-9A-F]{8}$/);
});

test('401 / 404 with a plain English sentence get the fixed Arabic text + code; raw codes and Arabic texts are untouched', async () => {
	const a = await get('/en-401'); assert.equal(a.status, 401); assert.equal(a.body.code, 'SESSION_REQUIRED'); assert.match(a.body.message, /[\u0600-\u06FF]/); assert.doesNotMatch(a.body.message, /Unauthorized/);
	const n = await get('/en-404'); assert.equal(n.status, 404); assert.equal(n.body.code, 'NOT_FOUND'); assert.doesNotMatch(n.body.message, /Provider not found/);
	assert.deepEqual((await get('/en-403-code')).body, { success: false, message: 'ROLE_MISMATCH', code: 'ROLE_MISMATCH' });
	assert.equal((await get('/ar-403')).body.message, 'هذا الحساب معطل حالياً، يرجى التواصل مع الدعم');
});
