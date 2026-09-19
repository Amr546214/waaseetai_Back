import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Confirmed DEV topology (see the comment above app.set('trust proxy', ...)
// in src/app.ts): a single host-level nginx proxies to the app via
// 127.0.0.1, appending the real client's IP to X-Forwarded-For. 'loopback'
// must trust that header ONLY when the immediate connection is actually
// from 127.0.0.1/::1 — never for a caller that connects directly (e.g. via
// the container's separately-published port) and forges the header itself.
//
// This exercises a minimal standalone Express app configured identically to
// app.ts's trust-proxy setting, rather than importing the real app.ts —
// app.ts transitively imports every route/service/prisma client, none of
// which this test needs or wants to touch.

function buildApp() {
	const app = express();
	app.set('trust proxy', 'loopback');
	app.get('/whoami', (req, res) => {
		res.json({ ip: req.ip });
	});
	return app;
}

test("trust proxy 'loopback': a request connecting from 127.0.0.1 has its X-Forwarded-For header trusted", async (t) => {
	const app = buildApp();
	const server = http.createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const { port } = server.address() as { port: number };
	const body = await new Promise<any>((resolve, reject) => {
		http.get({
			host: '127.0.0.1', port, path: '/whoami',
			headers: { 'X-Forwarded-For': '203.0.113.9' }
		}, (res) => {
			let data = '';
			res.on('data', (d) => (data += d));
			res.on('end', () => resolve(JSON.parse(data)));
		}).on('error', reject);
	});

	// The real test connection is itself from 127.0.0.1 (loopback), matching
	// how nginx actually connects to this app — so the forwarded client IP
	// must be trusted and surfaced as req.ip, exactly as it would be for a
	// real DEV visitor behind nginx.
	assert.equal(body.ip, '203.0.113.9');
});

test("trust proxy 'loopback': Express's compiled trust function rejects a non-loopback peer address", () => {
	const app = buildApp();
	// This is the exact internal function express-rate-limit/req.ip use to
	// decide whether to trust a given peer's X-Forwarded-For contribution —
	// calling it directly proves the configuration does NOT extend trust to
	// an arbitrary public IP (e.g. a caller hitting the container's
	// separately-published port directly and forging the header itself).
	const trustFn = app.get('trust proxy fn');
	assert.equal(trustFn('127.0.0.1', 0), true);
	assert.equal(trustFn('::1', 0), true);
	assert.equal(trustFn('203.0.113.5', 0), false);
	assert.equal(trustFn('8.8.8.8', 0), false);
});
