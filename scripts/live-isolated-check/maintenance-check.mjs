// Isolated end-to-end check of maintenance + settings propagation across TWO backend instances on one database (NOT part of `npm test`; nothing here touches dev / production).
// usage: node maintenance-check.mjs <seed.json> <api1> <api2>   (instances started with PLATFORM_DEPLOY_ENV=official FRONTEND_URL=https://waseetai.com on the same isolated DB)
import fs from 'node:fs';
import { io } from '/Users/amrokasha/Desktop/Waseet-Audit/wta/nb-fe/node_modules/socket.io-client/build/esm/index.js';
const [seedFile, A, B] = process.argv.slice(2); const d = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const out = {}; const sleep = ms => new Promise(r => setTimeout(r, ms));
const http = async (base, who, method, path, body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${d[who].token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j, retryAfter: r.headers.get('retry-after') }; };
const sock = (base, who) => new Promise(res => { const s = io(base, { transports: ['websocket'], reconnection: false, auth: who ? { token: d[who].token } : {} }); const st = { events: [], errors: [], s }; s.on('platform:state', p => st.events.push(p)); s.on('error', e => st.errors.push(String(e?.message ?? e))); s.on('connect', () => res(st)); s.on('connect_error', e => { st.errors.push('connect_error ' + e.message); res(st); }); });
const last = st => st.events[st.events.length - 1]?.maintenance;
const waitFor = async (st, pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred(last(st))) return true; await sleep(50); } return false; };
const view = async () => (await http(A, 'admin', 'GET', '/api/admin/system-settings')).json.data.items;
(async () => {
	const anon1 = await sock(A), anon2 = await sock(B), client2 = await sock(B, 'client'), sa2 = await sock(B, 'admin');
	await sleep(400); out.initialStateOnConnect = { anon1: last(anon1), anon2: last(anon2) };
	const items = await view(); const v = k => items.find(i => i.key === k).version;
	const save = (changes, ex) => http(A, 'admin', 'PUT', '/api/admin/system-settings', { changes, expected: ex });
	// 1) ON with a message, saved on instance A; the sockets of instance B (and A) must hear it without any request
	const t0 = Date.now(); out.saveOn = (await save({ maintenanceMode: true, maintenanceBannerText: 'نعود الساعة 5' }, { maintenanceMode: v('maintenanceMode'), maintenanceBannerText: v('maintenanceBannerText') })).status;
	out.onReachedAnonOnA = await waitFor(anon1, m => m?.on === true); out.onReachedAnonOnB_crossInstance = await waitFor(anon2, m => m?.on === true); out.onLatencyMsB = Date.now() - t0; out.messageOnB = last(anon2)?.message;
	// 2) the server refuses user operations: HTTP on BOTH instances, Socket.IO events of a client
	out.httpClientA = (await http(A, 'client', 'GET', '/api/client/finance/wallet')).status; out.httpClientB = (await http(B, 'client', 'GET', '/api/client/finance/wallet')); out.httpClientB = [out.httpClientB.status, out.httpClientB.json?.code, out.httpClientB.retryAfter];
	out.httpAnonB = (await http(B, null, 'GET', '/api/projects')).status; out.stateRouteB = (await http(B, null, 'GET', '/api/public/platform-state')).json?.data?.maintenance;
	out.healthB = (await http(B, null, 'GET', '/api/health')).status; out.loginPathAllowedB = (await http(B, null, 'POST', '/api/auth/login', { email: 'nobody@x.test', password: 'x' })).status; // 401/400 = reached the login logic, not 503
	out.webhookB = (await http(B, null, 'POST', '/api/payments/paypal/webhook', {})).status; out.paypalCreateB = (await http(B, 'client', 'POST', '/api/client/finance/paypal/order/create', { amount: 10 })).status;
	out.saHttpB = (await http(B, 'admin', 'GET', '/api/admin/system-settings')).status;
	// a client EVENT that normally answers (geo:suggest has an ack): refused for a client during maintenance (no ack), answered for the Super Admin socket and the public state read still works
	const ackOf = (st, ev) => new Promise(r => { st.s.emit(ev, a => r(a ?? 'ack')); setTimeout(() => r(undefined), 1200); });
	out.clientSocketEventGetsNoAck = (await ackOf(client2, 'geo:suggest')) === undefined; out.anonSocketEventGetsNoAck = (await ackOf(anon2, 'geo:suggest')) === undefined;
	out.saSocketEventAnswered = (await ackOf(sa2, 'geo:suggest')) !== undefined; out.stateReadStillWorks = !!(await ackOf(client2, 'platform:state:get'))?.maintenance?.on;
	// 3) a changed message is pushed too; 4) OFF returns everybody at once (no reload needed: the state simply flips)
	const it2 = await view(); out.saveMsg = (await save({ maintenanceBannerText: 'نعود الساعة 6' }, { maintenanceBannerText: it2.find(i => i.key === 'maintenanceBannerText').version })).status; out.msgReachedB = await waitFor(anon2, m => m?.message === 'نعود الساعة 6');
	const it3 = await view(); out.saveOff = (await save({ maintenanceMode: false }, { maintenanceMode: it3.find(i => i.key === 'maintenanceMode').version })).status; out.offReachedB = await waitFor(anon2, m => m?.on === false); out.offReachedA = await waitFor(anon1, m => m?.on === false);
	out.httpClientAfterOffB = (await http(B, 'client', 'GET', '/api/client/finance/wallet')).status;
	// 5) reconnect resync: a socket that connects after the change starts from the real state
	const late = await sock(B); await sleep(300); out.lateConnectGetsCurrentState = last(late); [anon1, anon2, client2, sa2, late].forEach(x => x.s.close());
	console.log(JSON.stringify(out, null, 1));
})();
