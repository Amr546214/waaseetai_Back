import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import zlib from 'node:zlib';
import { responseGzip } from './response-gzip.middleware';

const big = { success: true, data: Array.from({ length: 400 }, (_, i) => ({ id: i, label: 'أيقونة رقم ' + i, svg: '<path d="M0 0L10 10"/>' })) };
const app = express();
app.use(responseGzip);
app.get('/big', (_req, res) => { res.status(200).json(big); });
app.get('/small', (_req, res) => { res.json({ success: true }); });
app.get('/png', (_req, res) => { res.type('image/png').send(Buffer.alloc(5000, 1)); });
app.get('/text', (_req, res) => { res.type('text/plain').send('x'.repeat(5000)); });
app.get('/no-transform', (_req, res) => { res.set('Cache-Control', 'no-transform').json(big); });
app.get('/encoded', (_req, res) => { res.set('Content-Encoding', 'identity').json(big); });
app.get('/err', (_req, res) => { res.status(403).json({ success: false, message: 'ليست لديك صلاحية', pad: 'x'.repeat(3000) }); });

async function get(path: string, headers: Record<string, string> = { 'accept-encoding': 'gzip' }, method = 'GET') {
	const server = http.createServer(app).listen(0);
	try {
		const port = (server.address() as any).port;
		return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
			const r = http.request({ host: '127.0.0.1', port, path, method, headers }, res => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) })); });
			r.on('error', reject); r.end();
		});
	} finally { server.close(); }
}

test('a JSON answer of 1 KB or more is gzipped for a client that accepts it, and decodes to exactly the same body', async () => {
	const plain = await get('/big', {});
	const gz = await get('/big');
	assert.equal(plain.headers['content-encoding'], undefined);
	assert.equal(gz.headers['content-encoding'], 'gzip');
	assert.match(String(gz.headers['vary']), /Accept-Encoding/i);
	assert.ok(gz.body.length < plain.body.length / 3, `gz ${gz.body.length} vs plain ${plain.body.length}`);
	assert.equal(Number(gz.headers['content-length']), gz.body.length);
	assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body).toString('utf8')), JSON.parse(plain.body.toString('utf8')));
	assert.match(String(gz.headers['content-type']), /application\/json/);
});

test('error answers keep their status and are decoded to the same JSON', async () => {
	const gz = await get('/err');
	assert.equal(gz.status, 403);
	assert.equal(JSON.parse(zlib.gunzipSync(gz.body).toString('utf8')).message, 'ليست لديك صلاحية');
});

test('small, non-JSON, no-transform, already encoded and HEAD answers are left alone; a client without gzip gets the plain body', async () => {
	for (const p of ['/small', '/png', '/text', '/no-transform']) assert.equal((await get(p)).headers['content-encoding'], undefined, p);
	const enc = await get('/encoded'); assert.equal(enc.headers['content-encoding'], 'identity');
	const head = await get('/big', { 'accept-encoding': 'gzip' }, 'HEAD'); assert.equal(head.headers['content-encoding'], undefined);
	const none = await get('/big', { 'accept-encoding': 'identity' }); assert.equal(none.headers['content-encoding'], undefined); assert.ok(JSON.parse(none.body.toString('utf8')).success);
});

test('API_GZIP=off disables it', async () => {
	process.env.API_GZIP = 'off';
	try { assert.equal((await get('/big')).headers['content-encoding'], undefined); } finally { delete process.env.API_GZIP; }
});
