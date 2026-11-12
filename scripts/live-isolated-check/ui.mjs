import { chromium } from 'playwright-core'; import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('seed.json', 'utf8')); const API = 'http://127.0.0.1:5077'; const WEB = 'http://127.0.0.1:4300';
const browser = await chromium.launch({ headless: true, executablePath: '/Users/amrokasha/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const out = {}; const blocked = new Set();
async function page(who, path, wait = 4000) {
	const ctx = await browser.newContext({ locale: 'ar', viewport: { width: 1400, height: 1000 } });
	await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('waseet_token', t); localStorage.setItem('waseet_user', JSON.stringify(u)); } catch {} }, [d[who].token, d[who].user]);
	// nothing leaves the machine: the app's API origin is forwarded to the ISOLATED local API, every other external host is aborted
	await ctx.route('**/*', async route => {
		const u = new URL(route.request().url());
		if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
		if (u.hostname === 'dev.waseetai.com' && u.pathname.startsWith('/api/')) {
			const cors = { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': route.request().headers()['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
			if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
			const h = route.request().headers(); const fwd = {}; for (const k of ['authorization', 'content-type', 'idempotency-key', 'accept']) if (h[k]) fwd[k] = h[k];
			const r = await fetch(API + u.pathname + u.search, { method: route.request().method(), headers: fwd, body: ['GET', 'HEAD'].includes(route.request().method()) ? undefined : route.request().postData() ?? undefined }).catch(e => { console.error('forward failed', e.message); return null; });
			if (!r) return route.abort();
			const buf = Buffer.from(await r.arrayBuffer()); return route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', ...cors }, body: buf });
		}
		blocked.add(u.hostname); return route.abort();
	});
	const p = await ctx.newPage(); const apiCalls = [];
	p.on('response', r => { if (r.url().includes('/api/')) apiCalls.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
	await p.goto(WEB + path, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(wait);
	const text = (await p.innerText('body')).replace(/\s+/g, ' ');
	return { p, ctx, text, apiCalls, url: p.url() };
}
const run = async (name, who, path, checks, wait) => {
	const r = await page(who, path, wait); const res = { url: r.url, apiCalls: [...new Set(r.apiCalls)].slice(0, 12) };
	res.checks = Object.fromEntries(Object.entries(checks).map(([k, re]) => [k, new RegExp(re).test(r.text)])); res.sample = r.text.slice(0, 260); res.full = r.text.slice(r.text.indexOf('الدعم والمساعدة'), r.text.indexOf('الدعم والمساعدة') + 2600);
	out[name] = res; await r.ctx.close();
};
await run('client-home', 'client', `/client-overview`, { cancelledCard: 'QA-CONSENSUAL-PARTIAL[^A-Za-z]{0,60}ملغى', releaseCard: 'QA-ADMIN-RELEASE-LEGACY[^A-Za-z]{0,60}أُغلق بصرف إداري', noDisputedWording: '^(?!.*متنازع عليه).*$' }, 8000);
await run('admin-A-controls', 'admin', `/supper-admin-overview/contracts/${d.A.contractId}`, { closedReason: 'العقد مغلق|مغلق' }, 8000);
await run('client-rating-B', 'client', `/client-overview/projects/${d.B.requestId}/rating`, { noRateForm: '^(?!.*أرسل التقييم).*$' }, 7000);
fs.writeFileSync('ui.json', JSON.stringify({ blockedExternalHosts: [...blocked], out }, null, 1)); console.log(JSON.stringify({ blocked: [...blocked], out }, null, 1));
await browser.close();
