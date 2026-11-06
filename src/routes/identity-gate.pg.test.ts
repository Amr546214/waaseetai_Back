import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Identity gate (client + provider setup): REAL PostgreSQL (isolated local :55432, database qa_iso_gate*) + the REAL client / provider / admin-onboarding routers, controllers, services and
 * DB over HTTP. Replaced ONLY: `authenticate` (user id from a header: NOT a normal login) and the storage (no Cloudinary here: data: URIs become fake private refs that "exist").
 * The advisory AI check flag stays OFF (default). Synthetic data only.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432, database qa_iso_gate) to run' };
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.JWT_SECRET ??= 'test-secret'; process.env.FRONTEND_URL ??= 'https://front.test'; process.env.OPENAI_API_KEY ??= 'x';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
delete process.env.IDENTITY_AUTO_CHECK;

const PNG = (n: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, n)]).toString('base64')}`;
let ctx: Promise<any> | null = null;
async function env() {
	if (ctx) return ctx;
	ctx = (async () => {
		const { prisma } = await import('../config/db');
		const realAuth = await import('../middlewares/auth.middleware');
		mock.module('../middlewares/auth.middleware', { namedExports: { ...realAuth, authenticate: async (req: any, res: any, next: any) => {
			const id = req.headers['x-test-user']; const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
			if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
			req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' }; next();
		} } });
		const realStorage = await import('../utils/cloudinary-storage');
		mock.module('../utils/cloudinary-storage', { namedExports: { ...realStorage,
			storeKycFileIfNeeded: async (value: any, folder: string, name: string) => (typeof value === 'string' && value.startsWith('data:') ? `private:image:png:${folder}/${name}-${randomUUID().slice(0, 8)}` : (typeof value === 'string' && value) || undefined),
			privateFileExists: async () => true } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const client = (await import('./client-profile.routes')).default;
		const provider = (await import('./provider-profile.routes')).default;
		const admin = (await import('./admin-onboarding.routes')).default;
		const app = express(); app.use(express.json({ limit: '30mb' }));
		app.use('/client/profile', client); app.use('/provider/profile', provider); app.use('/admin/onboarding', admin);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any) => {
			const headers: Record<string, string> = { connection: 'close', ...(who ? { 'x-test-user': who } : {}) };
			let payload: any; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: payload });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
			return { status: res.status, json };
		};
		const gate = await import('../services/identity-gate.service');
		return { prisma, call, server, gate };
	})();
	return ctx;
}
after(async () => { if (ctx) { const e = await ctx; e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } });

type Party = 'CLIENT' | 'PROVIDER';
const base = (p: Party) => (p === 'CLIENT' ? '/client/profile' : '/provider/profile');
const DATA = { idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', idNumber: '29001011234567', dob: '1990-01-01' };
async function seed(party: Party) {
	const { prisma } = await env(); const tag = randomUUID().slice(0, 8); const id = () => randomUUID();
	const mk = (accountType: any, role: any, label: string) => prisma.user.create({ data: { id: id(), accountType, status: 'ACTIVE', roles: [role], activeRole: role, firstName: 'QA', lastName: label, email: `gate-${label}-${tag}@pg.test` } as any });
	const owner = await mk(party === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', party, 'owner');
	const other = await mk(party === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', party, 'other');
	const admin = await mk('SUPER_ADMIN', 'SUPER_ADMIN', 'admin');
	const plainAdmin = await mk('ADMIN', 'ADMIN', 'plain');
	if (party === 'CLIENT') { await prisma.clientProfile.create({ data: { id: id(), userId: owner.id } as any }); await prisma.clientProfile.create({ data: { id: id(), userId: other.id } as any }); }
	else { await prisma.providerProfile.create({ data: { id: id(), userId: owner.id } as any }); await prisma.providerProfile.create({ data: { id: id(), userId: other.id } as any }); }
	return { prisma, owner, other, admin, plainAdmin, party };
}
type W = Awaited<ReturnType<typeof seed>>;
const profile = (w: W, userId = w.owner.id) => (w.party === 'CLIENT' ? w.prisma.clientProfile : w.prisma.providerProfile).findUnique({ where: { userId } }) as Promise<any>;
const state = async (w: W) => (await (await env()).call('GET', `${base(w.party)}/setup/identity`, w.owner.id)).json.data;
const submit = async (w: W, body: any = { ...DATA, frontId: PNG(1), backId: PNG(2) }) => (await env()).call('PUT', `${base(w.party)}/setup/identity`, w.owner.id, body);
const approve = async (w: W, who: string | null = w.admin.id, body: any = {}) => {
	const { call, prisma } = await env();
	if (w.party === 'CLIENT') { const o = await prisma.clientOnboarding.findUnique({ where: { userId: w.owner.id } }); return call('POST', `/admin/onboarding/${o?.id ?? randomUUID()}/approve`, who, body); }
	return call('POST', `/admin/onboarding/kyc/providers/${w.owner.id}/approve`, who, body);
};
const reject = async (w: W, reason = 'الصورة غير واضحة، ارفع صورة أوضح') => {
	const { call, prisma } = await env();
	if (w.party === 'CLIENT') { const o = await prisma.clientOnboarding.findUnique({ where: { userId: w.owner.id } }); return call('POST', `/admin/onboarding/${o!.id}/reject`, w.admin.id, { rejectionReason: reason }); }
	return call('POST', `/admin/onboarding/kyc/providers/${w.owner.id}/reject`, w.admin.id, { rejectionReason: reason });
};
const clientFinal = () => ({ details: { ...DATA, country: 'مصر', city: 'القاهرة', occupation: 'مهندس', address: 'عنوان', bio: 'نبذة' }, identity: {}, documents: {}, agreements: { accurate: true, terms: true, privacy: true } });
/** Every request that must be closed while the identity is not approved. */
const blocked = (w: W): Array<[string, string, string, any]> => w.party === 'CLIENT'
	? [['step 3', 'PUT', '/client/profile/setup/step/3', { paypalPayoutEmail: 'a@b.com' }], ['step 4', 'PUT', '/client/profile/setup/step/4', { documents: { notes: 'x' } }], ['final', 'POST', '/client/profile/setup', clientFinal()]]
	: [['agreements', 'POST', '/provider/profile/setup', { agreements: { accurate: true, terms: true, privacy: true } }], ['documents', 'POST', '/provider/profile/setup', { documents: { notes: 'x' } }], ['final', 'POST', '/provider/profile/setup', { details: { country: 'EG' }, portfolio: [], agreements: { accurate: true, terms: true, privacy: true } }]];
const assertBlocked = async (w: W, expected: string) => {
	const { call } = await env();
	for (const [label, m, url, body] of blocked(w)) {
		const r = await call(m, url, w.owner.id, body);
		assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.json)}`);
		assert.equal(r.json.code, 'IDENTITY_NOT_APPROVED', label);
		assert.equal(r.json.errors[0].status, expected, label);
	}
};
const assertOpen = async (w: W) => {
	const { call } = await env();
	for (const [label, m, url, body] of blocked(w)) {
		const r = await call(m, url, w.owner.id, body);
		assert.notEqual(r.json?.code, 'IDENTITY_NOT_APPROVED', `${label} must not be gated: ${JSON.stringify(r.json)}`);
	}
};

for (const party of ['CLIENT', 'PROVIDER'] as Party[]) {
	test(`PG ${party}: a normal photo upload starts the review and advances NOTHING; every skipping request is refused (409 IDENTITY_NOT_APPROVED)`, opts, async () => {
		const { call, prisma } = await env(); const w = await seed(party);
		assert.equal((await state(w)).status, 'NOT_SUBMITTED');
		await assertBlocked(w, 'NOT_SUBMITTED'); // direct API calls, nothing submitted at all
		const r = await submit(w);
		assert.equal(r.status, 200, JSON.stringify(r.json));
		assert.equal(r.json.data.status, 'UNDER_REVIEW'); assert.equal(r.json.data.canAdvance, false); assert.deepEqual(r.json.data.missing, []);
		assert.equal(r.json.data.data.hasFront, true); assert.ok(!JSON.stringify(r.json).includes('private:'), 'no storage reference reaches the owner');
		assert.equal((await profile(w)).kycStatus, 'PENDING');
		if (party === 'CLIENT') assert.equal((await prisma.clientOnboarding.findUnique({ where: { userId: w.owner.id } }))!.status, 'PENDING');
		await assertBlocked(w, 'UNDER_REVIEW'); // under review: next steps and the final submission are refused by the SERVER
		// the user may still correct the data/photo while under review: stays under review (no advance)
		const again = await submit(w, { frontId: PNG(9) });
		assert.equal(again.json.data.status, 'UNDER_REVIEW');
		assert.equal(await prisma.identityFieldCheck.count({ where: { userId: w.owner.id } }), 0, 'advisory AI check stays OFF');
		void call;
	});

	test(`PG ${party}: rejection shows the reason, keeps the data, re-upload re-opens the review; approval opens the next step`, opts, async () => {
		const w = await seed(party);
		await submit(w);
		assert.equal((await reject(w)).status, 200);
		let s = await state(w);
		assert.equal(s.status, 'REJECTED'); assert.equal(s.rejectionReason, 'الصورة غير واضحة، ارفع صورة أوضح'); assert.equal(s.canAdvance, false);
		assert.equal(s.data.idNumber, DATA.idNumber); assert.equal(s.data.hasFront, true); assert.equal(s.data.hasBack, true); // data kept
		await assertBlocked(w, 'REJECTED');
		const r = await submit(w, { frontId: PNG(5) }); // re-upload only the photo: data not re-sent, not erased
		assert.equal(r.json.data.status, 'UNDER_REVIEW'); assert.equal(r.json.data.rejectionReason, null); assert.equal(r.json.data.data.idNumber, DATA.idNumber);
		assert.equal((await approve(w)).status, 200);
		s = await state(w);
		assert.equal(s.status, 'APPROVED'); assert.equal(s.canAdvance, true);
		assert.ok((await profile(w)).identityApprovedDigest);
		await assertOpen(w);
	});

	test(`PG ${party}: changing the PHOTO or the identity DATA after approval cancels it and re-blocks; an unchanged re-save keeps it`, opts, async () => {
		const w = await seed(party);
		await submit(w); await approve(w);
		assert.equal((await submit(w, { ...DATA })).json.data.status, 'APPROVED', 'same data re-sent: approval kept');
		let r = await submit(w, { backId: PNG(7) });
		assert.equal(r.json.data.status, 'UNDER_REVIEW', 'new photo cancels the approval');
		assert.equal((await profile(w)).identityApprovedDigest, null);
		if (party === 'PROVIDER') assert.equal((await profile(w)).isVerified, false);
		await assertBlocked(w, 'UNDER_REVIEW');
		await approve(w); assert.equal((await state(w)).status, 'APPROVED');
		r = await submit(w, { idNumber: '29001011234568' });
		assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.data.status, 'UNDER_REVIEW', 'changed data cancels the approval');
		await assertBlocked(w, 'UNDER_REVIEW');
		await approve(w);
		// the legacy wizard paths cancel too: client step 2 / provider POST /setup with a new image
		const { call } = await env();
		const legacy = party === 'CLIENT'
			? await call('PUT', '/client/profile/setup/step/2', w.owner.id, { identity: { frontId: PNG(11) } })
			: await call('POST', '/provider/profile/setup', w.owner.id, { identity: { frontId: PNG(11) } });
		assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
		assert.equal((await state(w)).status, 'UNDER_REVIEW');
		await assertBlocked(w, 'UNDER_REVIEW');
	});

	test(`PG ${party}: the admin approval is bound to what was reviewed (stale digest -> 409 IDENTITY_CHANGED_SINCE_REVIEW)`, opts, async () => {
		const { call, prisma } = await env(); const w = await seed(party);
		await submit(w);
		const reviewed = (await profile(w));
		const { identityDigest } = (await env()).gate;
		const seen = identityDigest(reviewed);
		await submit(w, { frontId: PNG(33) }); // the owner changes the photo while the admin is looking at the old one
		const r = await approve(w, w.admin.id, { identityDigest: seen });
		assert.equal(r.status, 409); assert.equal(r.json.code, 'IDENTITY_CHANGED_SINCE_REVIEW');
		assert.equal((await state(w)).status, 'UNDER_REVIEW');
		// the admin lists expose the current digest; approving with it works
		const list = party === 'CLIENT' ? await call('GET', '/admin/onboarding?status=PENDING&limit=100', w.admin.id) : await call('GET', `/admin/onboarding/kyc/providers?search=${w.owner.id}`, w.admin.id);
		const row = list.json.data.items.find((i: any) => (i.userId ?? i.user?.id) === w.owner.id);
		assert.equal(row.identityDigest, identityDigest(await profile(w)));
		assert.equal((await approve(w, w.admin.id, { identityDigest: row.identityDigest })).status, 200);
		assert.equal((await state(w)).status, 'APPROVED');
		void prisma;
	});

	test(`PG ${party}: authorisation: other users see only their own state, strangers/non-admins/admin without permission cannot decide`, opts, async () => {
		const { call, prisma } = await env(); const w = await seed(party);
		await submit(w);
		const otherState = (await call('GET', `${base(party)}/setup/identity`, w.other.id)).json.data;
		assert.equal(otherState.status, 'NOT_SUBMITTED'); assert.equal(otherState.data.idNumber, null); assert.equal(otherState.data.hasFront, false);
		assert.equal((await call('GET', `${base(party)}/setup/identity`, null)).status, 401);
		assert.equal((await submit({ ...w, owner: w.other } as W, { ...DATA, frontId: PNG(3), backId: PNG(4) })).status, 200); // another user submits THEIR OWN
		assert.equal((await profile(w)).idNumber, DATA.idNumber); assert.equal((await state(w)).status, 'UNDER_REVIEW');
		for (const who of [w.owner.id, w.other.id, w.plainAdmin.id, null]) {
			const r = await approve(w, who);
			assert.ok([401, 403].includes(r.status), `who=${who} got ${r.status}`);
		}
		assert.equal((await state(w)).status, 'UNDER_REVIEW', 'nothing was approved');
		// a user cannot approve themselves by sending fields through the owner endpoints
		const hack = await call('PUT', `${base(party)}/setup/identity`, w.owner.id, { kycStatus: 'VERIFIED' });
		assert.equal(hack.status, 400);
		assert.equal((await profile(w)).kycStatus, 'PENDING');
		if (party === 'CLIENT') assert.equal((await call('GET', '/provider/profile/setup/identity', w.owner.id)).status, 403);
		void prisma;
	});

	test(`PG ${party}: concurrency: a double submit leaves one consistent review; approve vs change never leaves an approval of stale evidence`, opts, async () => {
		const { prisma, gate } = await env(); const w = await seed(party);
		const rs = await Promise.all([submit(w), submit(w), submit(w)]);
		assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.status)));
		assert.equal((await state(w)).status, 'UNDER_REVIEW');
		if (party === 'CLIENT') assert.equal(await prisma.clientOnboarding.count({ where: { userId: w.owner.id } }), 1);
		for (let i = 0; i < 6; i++) {
			const cur = await profile(w);
			const [a, c] = await Promise.all([approve(w, w.admin.id, { identityDigest: gate.identityDigest(cur) }), submit(w, { frontId: PNG(40 + i) })]);
			assert.ok([200, 409].includes(a.status) && c.status === 200, `approve ${a.status} change ${c.status}`);
			const after = await profile(w);
			if (after.kycStatus === 'VERIFIED') assert.equal(after.identityApprovedDigest, gate.identityDigest(after), 'an approval always matches the current evidence');
			assert.notEqual((await state(w)).status, 'APPROVED', 'the change was after / cancelled the approval');
			if (after.kycStatus !== 'PENDING') await submit(w, { frontId: PNG(80 + i) });
		}
	});
}

test('PG CLIENT: a legacy approval (no stored digest) is APPROVED; its data stays frozen (409) but a new photo cancels it', opts, async () => {
	const { call, prisma } = await env(); const w = await seed('CLIENT');
	await prisma.clientProfile.update({ where: { userId: w.owner.id }, data: { ...DATA, dob: new Date('1990-01-01'), frontIdUrl: `private:image:png:waseetai/clients/${w.owner.id}/identity/f-old`, backIdUrl: `private:image:png:waseetai/clients/${w.owner.id}/identity/b-old`, kycStatus: 'VERIFIED' } });
	assert.equal((await state(w)).status, 'APPROVED');
	const r = await submit(w, { idNumber: '29001011234999' });
	assert.equal(r.status, 409); assert.equal((await state(w)).status, 'APPROVED');
	assert.equal((await submit(w, { frontId: PNG(2) })).json.data.status, 'UNDER_REVIEW');
	void call;
});

test('PG PROVIDER: pre-identity content (details / specialties) is still saved without the gate', opts, async () => {
	const { call } = await env(); const w = await seed('PROVIDER');
	const r = await call('POST', '/provider/profile/setup', w.owner.id, { details: { country: 'EG', city: 'القاهرة' } });
	assert.equal(r.status, 200, JSON.stringify(r.json));
});
