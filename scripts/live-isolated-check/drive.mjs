import fs from 'node:fs';
const L = process.argv[2]; const d = JSON.parse(fs.readFileSync(`${L}/seed.json`, 'utf8')); const B = 'http://127.0.0.1:5077';
const call = async (who, method, path, body, headers = {}) => { const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${d[who].token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j }; };
const out = {};
// A: ADMIN RELEASE (legacy escrow, nothing approved) through the REAL admin API
const ctl = await call('admin', 'GET', `/api/admin/contracts/${d.A.contractId}/controls`); out.aControls = ctl.status;
const rel = await call('admin', 'POST', `/api/admin/contracts/${d.A.contractId}/release`, { reason: 'صرف إداري للتحقق الحي', expectedVersion: ctl.json.data.version, confirm: true, expectedHeldAmount: 20 }, { 'idempotency-key': 'live-release-' + d.A.contractId.slice(0, 8) });
out.aRelease = [rel.status, rel.json?.data?.settlement ?? rel.json?.message];
// B: CONSENSUAL cancellation through the REAL client / provider / admin endpoints
const cr = await call('client', 'POST', `/api/client/projects/${d.B.requestId}/cancellation-requests`, { reason: 'اتفاق على الإلغاء بالتراضي', requestKey: 'live-' + d.B.requestId.slice(0, 8) }); out.bCreate = [cr.status, cr.json?.message ?? cr.json?.data?.status];
const crId = cr.json?.data?.id;
const ok = await call('provider', 'POST', `/api/provider/cancellation-requests/${crId}/respond`, { decision: 'accept' }); out.bAccept = [ok.status, ok.json?.data?.status];
const st = await call('admin', 'POST', `/api/admin/cancellation-requests/${crId}/settle`, { releaseToProvider: 4, expectedHeldAmount: 10, reason: 'تسوية جزئية للتحقق الحي' }); out.bSettle = [st.status, st.json?.data?.status ?? st.json?.message];
out.bCrId = crId;
fs.writeFileSync(`${L}/drive.json`, JSON.stringify(out, null, 1)); console.log(JSON.stringify(out));
