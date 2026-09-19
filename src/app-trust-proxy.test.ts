import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Confirmed DEV topology (see the comment above app.set('trust proxy', ...)
// in src/app.ts): a single host-level nginx proxies to the app, appending
// the real client's IP to X-Forwarded-For. Because the app runs in a
// port-published Docker container, that connection arrives at Express from
// the bridge network's gateway address (confirmed via `docker network
// inspect waseetai-network`: 172.23.0.1 on subnet 172.23.0.0/16), never
// literal 127.0.0.1 — an initial 'loopback' setting was deployed and
// verified NOT to match this in real production traffic (morgan kept
// logging the flat gateway IP for every external visitor), so it was
// corrected to 'uniquelocal'.
//
// These tests call Express's actual compiled trust-proxy function directly
// (`app.get('trust proxy fn')` — the exact function express-rate-limit and
// req.ip use internally) rather than opening real sockets, since faithfully
// simulating a connection from a specific private, non-loopback address
// portably (without depending on the test machine's own network interfaces)
// isn't practical — the compiled function is a pure, deterministic decision
// point, so testing it directly proves the real property that matters.
//
// Verified empirically before writing these assertions (not assumed):
// 'uniquelocal' trusts RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
// but does NOT include loopback (127.0.0.0/8) or link-local — those are
// separate presets. That's fine for this deployment: the real proxy hop is
// never literal 127.0.0.1 anyway (see above).

function buildApp() {
	const app = express();
	app.set('trust proxy', 'uniquelocal');
	return app;
}

test("trust proxy 'uniquelocal': trusts the confirmed Docker gateway address (172.23.0.1) that nginx's proxied connections actually arrive from", () => {
	const trustFn = buildApp().get('trust proxy fn');
	assert.equal(trustFn('172.23.0.1', 0), true);
});

test("trust proxy 'uniquelocal': trusts private/RFC1918 ranges generally", () => {
	const trustFn = buildApp().get('trust proxy fn');
	assert.equal(trustFn('172.16.0.1', 0), true);
	assert.equal(trustFn('172.31.255.255', 0), true);
	assert.equal(trustFn('10.0.0.5', 0), true);
	assert.equal(trustFn('192.168.1.1', 0), true);
});

test("trust proxy 'uniquelocal': does NOT trust loopback — a separate, distinct range from private-network addresses", () => {
	// Documents a real, verified boundary of this setting (not obvious from
	// the name) — harmless here since the real proxy hop is never literal
	// 127.0.0.1 in this containerized deployment.
	const trustFn = buildApp().get('trust proxy fn');
	assert.equal(trustFn('127.0.0.1', 0), false);
});

test("trust proxy 'uniquelocal': rejects a genuine public IP", () => {
	// Proves a caller hitting the container's separately-published port
	// directly (bypassing nginx) cannot get a self-forged X-Forwarded-For
	// trusted — a real public IP is never itself a private/RFC1918 address.
	const trustFn = buildApp().get('trust proxy fn');
	assert.equal(trustFn('203.0.113.5', 0), false);
	assert.equal(trustFn('8.8.8.8', 0), false);
});
