import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/**
 * Admin team messaging on REAL PostgreSQL over HTTP + a real Socket.IO server: membership is the only door into a conversation, a send is saved once however many times it is submitted, "read"
 * is never implied by arrival, and withdrawing access cuts the open connection. Isolated database only.
 */
after(closeEnv);
const cid = () => randomUUID();
const M = '/admin/messages';
const member = async (e: any, tag = 'm') => mkStaff(e, ['messages.use'], tag);
const start = async (e: any, from: string, to: string) => { const r = await e.call('POST', `${M}/conversations`, from, { userId: to }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.json)); return r.json.data.id as string; };
const send = (e: any, who: string, conv: string, body: string, clientMessageId = cid()) => e.call('POST', `${M}/conversations/${conv}/messages`, who, { body, clientMessageId });
const deny = async (e: any, userId: string, permission: string) => { const d = (await e.call('GET', `/admin/team/staff/${userId}/access`, e.sa.id)).json.data; const r = await e.call('PUT', `/admin/team/staff/${userId}/access`, e.sa.id, { overrides: [{ permission, effect: 'DENY' }], expectedVersion: d.version }); assert.equal(r.status, 200, JSON.stringify(r.json)); };

test('PG messages: only an account holding messages.use reaches any route - unplaced / no-permission staff, customers, providers and marketers get 403 and nothing is written', opts, async () => {
	const e = await env(); const bare = await e.mkUser('ADMIN', 'bare'); const noPerm = await mkStaff(e, ['users.view'], 'np');
	const outsiders = [bare, noPerm.user, await e.mkUser('CLIENT_INDIVIDUAL', 'c'), await e.mkUser('PROVIDER_INDIVIDUAL', 'p'), await e.mkUser('MARKETER' as any, 'mk').catch(() => null)].filter(Boolean) as any[];
	const ok = await member(e); const before = await e.prisma.adminConversation.count();
	for (const u of outsiders) for (const [m, url, body] of [['GET', `${M}/directory`], ['GET', `${M}/conversations`], ['POST', `${M}/conversations`, { userId: ok.user.id }], ['GET', `${M}/unread-count`], ['POST', `${M}/conversations/x/messages`, { body: 'hi', clientMessageId: cid() }]] as const) {
		const r = await e.call(m, url, u.id, body as any); assert.equal(r.status, 403, `${u.accountType} ${m} ${url}`);
	}
	assert.equal((await e.call('GET', `${M}/directory`, null)).status, 401);
	assert.equal(await e.prisma.adminConversation.count(), before);
	assert.equal((await e.call('GET', `${M}/directory`, ok.user.id)).status, 200);
	assert.equal((await e.call('GET', `${M}/directory`, e.sa.id)).status, 200); // a SUPER_ADMIN holds it as every permission
});

test('PG messages: the directory lists only live staff holding the permission (never self, a suspended member, a member without it or any non-staff account)', opts, async () => {
	const e = await env(); const a = await member(e, 'da'); const b = await member(e, 'db'); const c = await member(e, 'dc'); const np = await mkStaff(e, ['users.view'], 'dn'); const client = await e.mkUser('CLIENT_INDIVIDUAL', 'dcl');
	await e.call('POST', `/admin/team/staff/${c.user.id}/suspend`, e.sa.id);
	const d = (await e.call('GET', `${M}/directory`, a.user.id)).json.data as any[]; const ids = d.map(x => x.userId);
	// the list is capped (200, by name): on a crowded database ask for the specific people by name
	const find = async (who: any) => ((await e.call('GET', `${M}/directory?q=${encodeURIComponent(who.firstName)}`, a.user.id)).json.data as any[]).map(x => x.userId);
	assert.ok((await find(b.user)).includes(b.user.id)); assert.ok((await find(e.sa)).includes(e.sa.id)); assert.ok(!ids.includes(a.user.id)); assert.ok(!ids.includes(c.user.id)); assert.ok(!ids.includes(np.user.id)); assert.ok(!ids.includes(client.id));
	assert.equal(((await e.call('GET', `${M}/directory?q=${encodeURIComponent(e.sa.firstName)}`, a.user.id)).json.data as any[]).find(x => x.userId === e.sa.id).role, 'مدير النظام');
	assert.deepEqual(Object.keys(d[0]).sort(), ['name', 'role', 'userId']); // no e-mail, no phone
	const q = (await e.call('GET', `${M}/directory?q=${encodeURIComponent(b.user.firstName)}`, a.user.id)).json.data as any[]; assert.ok(q.some(x => x.userId === b.user.id));
});

test('PG messages: starting a conversation is idempotent per pair (even concurrent), refuses self / an ineligible account, and a pair never has two conversations', opts, async () => {
	const e = await env(); const a = await member(e, 'sa'); const b = await member(e, 'sb'); const np = await mkStaff(e, ['users.view'], 'sn'); const client = await e.mkUser('CLIENT_INDIVIDUAL', 'scl');
	const ids = await Promise.all([1, 2, 3, 4].map((i) => e.call('POST', `${M}/conversations`, i % 2 ? a.user.id : b.user.id, { userId: i % 2 ? b.user.id : a.user.id })));
	for (const r of ids) assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
	assert.equal(new Set(ids.map(r => r.json.data.id)).size, 1);
	assert.equal(await e.prisma.adminConversationMember.count({ where: { conversationId: ids[0].json.data.id } }), 2);
	for (const bad of [a.user.id, np.user.id, client.id, randomUUID(), '']) assert.ok([400, 404].includes((await e.call('POST', `${M}/conversations`, a.user.id, { userId: bad })).status), String(bad));
	assert.equal((await e.call('POST', `${M}/conversations`, a.user.id, { userId: b.user.id, extra: 1 })).status, 400);
});

test('PG messages: send / receive / persistence - saved rows survive a refresh, ordering is by seq, the sender sees "mine", the recipient sees unread', opts, async () => {
	const e = await env(); const a = await member(e, 'pa'); const b = await member(e, 'pb'); const conv = await start(e, a.user.id, b.user.id);
	for (const t of ['أهلًا', 'سطر أول\nسطر ثانٍ', 'ثالثة']) assert.equal((await send(e, a.user.id, conv, t)).status, 201);
	assert.equal((await send(e, b.user.id, conv, 'رد')).status, 201);
	const list = (await e.call('GET', `${M}/conversations`, b.user.id)).json.data; const row = list.find((c: any) => c.id === conv);
	assert.equal(row.unread, 3); assert.equal(row.counterpart.userId, a.user.id); assert.equal(row.lastMessage.body, 'رد'); assert.equal(row.lastMessage.mine, true);
	for (const who of [a.user.id, b.user.id]) { // "refresh": a fresh request returns the same saved history for both
		const h = (await e.call('GET', `${M}/conversations/${conv}/messages`, who)).json.data; assert.deepEqual(h.messages.map((m: any) => m.body), ['أهلًا', 'سطر أول\nسطر ثانٍ', 'ثالثة', 'رد']); assert.equal(h.hasMore, false);
		const seqs = h.messages.map((m: any) => BigInt(m.seq)); assert.deepEqual([...seqs].sort((x, y) => (x < y ? -1 : 1)), seqs);
	}
	const page = (await e.call('GET', `${M}/conversations/${conv}/messages?limit=2`, a.user.id)).json.data; assert.equal(page.messages.length, 2); assert.equal(page.hasMore, true);
	const older = (await e.call('GET', `${M}/conversations/${conv}/messages?limit=5&before=${page.messages[0].seq}`, a.user.id)).json.data; assert.deepEqual(older.messages.map((m: any) => m.body), ['أهلًا', 'سطر أول\nسطر ثانٍ']);
	assert.equal((await e.call('GET', `${M}/conversations/${conv}/messages?before=abc`, a.user.id)).status, 400);
});

test('PG messages: a double click / a lost reply + retry saves ONE row - the same clientMessageId returns the same message, concurrently too, and pushes it once', opts, async () => {
	const e = await env(); const { setSocketServer } = await import('../utils/socket-registry'); const pushes: string[] = [];
	setSocketServer({ to: (room: string) => ({ emit: (ev: string) => pushes.push(`${room}:${ev}`) }) } as any);
	try {
		const a = await member(e, 'ia'); const b = await member(e, 'ib'); const conv = await start(e, a.user.id, b.user.id); const key = cid();
		const rs = await Promise.all([1, 2, 3, 4, 5].map(() => send(e, a.user.id, conv, 'مرة واحدة', key)));
		for (const r of rs) assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
		assert.equal(new Set(rs.map(r => r.json.data.message.id)).size, 1); assert.equal(await e.prisma.adminMessage.count({ where: { conversationId: conv } }), 1);
		assert.equal(pushes.filter(p => p.endsWith(':admin_message_new')).length, 2); // once to each of the two members, not once per request
		// the same key with DIFFERENT text is a conflict: refused (409), never a misleading success, and the saved message is unchanged
		const again = await send(e, a.user.id, conv, 'نص مختلف عمدًا', key); assert.equal(again.status, 409); assert.equal(again.json.code, 'CLIENT_MESSAGE_ID_CONFLICT'); assert.equal(again.json.data, undefined);
		const stored = await e.prisma.adminMessage.findMany({ where: { conversationId: conv } }); assert.equal(stored.length, 1); assert.equal(stored[0].body, 'مرة واحدة'); assert.equal(stored[0].id, rs[0].json.data.message.id);
		const mixed = await Promise.all([send(e, a.user.id, conv, 'نص آخر ١', cid()).then(r => r.status), ...[1, 2, 3].map(() => send(e, a.user.id, conv, 'سباق', 'race-key-0001').then(r => r.status))]);
		assert.ok(mixed.slice(1).every(s => [200, 201].includes(s))); await e.prisma.adminMessage.deleteMany({ where: { conversationId: conv, body: 'نص آخر ١' } });
		const raceRows = await e.prisma.adminMessage.count({ where: { conversationId: conv, clientMessageId: 'race-key-0001' } }); assert.equal(raceRows, 1); await e.prisma.adminMessage.deleteMany({ where: { conversationId: conv, clientMessageId: 'race-key-0001' } });
		assert.equal((await send(e, a.user.id, conv, 'ثانية', cid())).status, 201); assert.equal(await e.prisma.adminMessage.count({ where: { conversationId: conv } }), 2);
		// the same key from the OTHER member is a different message (keys are per sender)
		assert.equal((await send(e, b.user.id, conv, 'من الطرف الآخر', key)).status, 201); assert.equal(await e.prisma.adminMessage.count({ where: { conversationId: conv } }), 3);
	} finally { setSocketServer(null); }
});

test('PG messages: unread - arrival never marks read; only the member marking read does, forward only, clamped to the latest, own messages never count; totals match', opts, async () => {
	const e = await env(); const a = await member(e, 'ua'); const b = await member(e, 'ub'); const c = await member(e, 'uc'); const c1 = await start(e, a.user.id, b.user.id); const c2 = await start(e, c.user.id, b.user.id);
	for (let i = 0; i < 3; i++) await send(e, a.user.id, c1, `a${i}`); await send(e, c.user.id, c2, 'c0'); await send(e, b.user.id, c1, 'b0');
	const get = async (who: string, conv: string) => (await e.call('GET', `${M}/conversations`, who)).json.data.find((x: any) => x.id === conv);
	assert.equal((await get(b.user.id, c1)).unread, 3); assert.equal((await get(a.user.id, c1)).unread, 1); assert.equal((await e.call('GET', `${M}/unread-count`, b.user.id)).json.data.unread, 4);
	await e.call('GET', `${M}/conversations/${c1}/messages`, b.user.id); // opening the history alone does not mark read
	assert.equal((await get(b.user.id, c1)).unread, 3);
	const hist = (await e.call('GET', `${M}/conversations/${c1}/messages`, b.user.id)).json.data.messages; const second = hist[1].seq;
	assert.equal((await e.call('POST', `${M}/conversations/${c1}/read`, b.user.id, { upToSeq: second })).json.data.unread, 1);
	assert.equal((await e.call('POST', `${M}/conversations/${c1}/read`, b.user.id, { upToSeq: hist[0].seq })).json.data.unread, 1); // never backwards
	assert.equal((await e.call('POST', `${M}/conversations/${c1}/read`, b.user.id, { upToSeq: '999999999999999999' })).json.data.unread, 0); // clamped
	assert.equal((await e.call('GET', `${M}/unread-count`, b.user.id)).json.data.unread, 1);
	assert.equal((await e.call('POST', `${M}/conversations/${c1}/read`, b.user.id, { upToSeq: 'x' })).status, 400);
	assert.equal((await get(a.user.id, c1)).unread, 1); // the other side's counter is independent
});

test('PG messages: membership is the only door - another staff member holding the permission, and a SUPER_ADMIN, cannot read, send to, mark or find someone else\'s conversation', opts, async () => {
	const e = await env(); const a = await member(e, 'xa'); const b = await member(e, 'xb'); const spy = await member(e, 'xs'); const conv = await start(e, a.user.id, b.user.id); await send(e, a.user.id, conv, 'سري-' + conv.slice(0, 6));
	for (const who of [spy.user.id, e.sa.id]) {
		assert.equal((await e.call('GET', `${M}/conversations/${conv}/messages`, who)).status, 404);
		assert.equal((await send(e, who, conv, 'تطفل')).status, 404);
		assert.equal((await e.call('POST', `${M}/conversations/${conv}/read`, who, { upToSeq: '1' })).status, 404);
		assert.ok(!(await e.call('GET', `${M}/conversations`, who)).json.data.some((c: any) => c.id === conv));
		assert.deepEqual((await e.call('GET', `${M}/conversations?q=${encodeURIComponent('سري-' + conv.slice(0, 6))}`, who)).json.data, []); // search is inside my own conversations only
	}
	assert.equal((await e.call('GET', `${M}/conversations/${randomUUID()}/messages`, a.user.id)).status, 404);
	assert.equal(await e.prisma.adminMessage.count({ where: { conversationId: conv } }), 1);
	// search finds it for a member, by text and by the other person's name
	assert.equal((await e.call('GET', `${M}/conversations?q=${encodeURIComponent('سري-' + conv.slice(0, 6))}`, b.user.id)).json.data.length, 1);
	assert.ok((await e.call('GET', `${M}/conversations?q=${encodeURIComponent(a.user.firstName)}`, b.user.id)).json.data.some((c: any) => c.id === conv));
});

test('PG messages: input is validated and nothing smuggles in - empty / long / bad key / unknown fields are refused with a field message and save nothing', opts, async () => {
	const e = await env(); const a = await member(e, 'va'); const b = await member(e, 'vb'); const conv = await start(e, a.user.id, b.user.id); const n = () => e.prisma.adminMessage.count({ where: { conversationId: conv } });
	for (const body of [{ body: '   ', clientMessageId: cid() }, { body: '', clientMessageId: cid() }, { body: 'x'.repeat(4001), clientMessageId: cid() }, { body: 'ok', clientMessageId: 'short' }, { body: 'ok' }, { body: 'ok', clientMessageId: cid(), senderId: b.user.id }, { body: 'ok', clientMessageId: cid(), seq: 1 }, { body: 5, clientMessageId: cid() }]) {
		const r = await e.call('POST', `${M}/conversations/${conv}/messages`, a.user.id, body as any); assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
	}
	assert.equal(await n(), 0); assert.equal((await send(e, a.user.id, conv, 'x'.repeat(4000))).status, 201); assert.equal(await n(), 1);
	assert.equal((await e.call('GET', `${M}/conversations/${conv}/messages`, a.user.id)).json.data.messages[0].senderId, a.user.id);
});

test('PG messages: withdrawing access applies at once - own DENY / suspension = 403 on the next request; a counterpart who lost access cannot be messaged; history stays readable only to members', opts, async () => {
	const e = await env(); const a = await member(e, 'wa'); const b = await member(e, 'wb'); const conv = await start(e, a.user.id, b.user.id); await send(e, a.user.id, conv, 'قبل السحب');
	await deny(e, b.user.id, 'messages.use');
	const r = await send(e, a.user.id, conv, 'بعد سحب الطرف الآخر'); assert.equal(r.status, 409); assert.equal(r.json.code, 'COUNTERPART_UNAVAILABLE');
	for (const [m, url] of [['GET', `${M}/conversations`], ['GET', `${M}/conversations/${conv}/messages`], ['GET', `${M}/unread-count`]] as const) assert.equal((await e.call(m, url, b.user.id)).status, 403, url);
	const s = await member(e, 'ws'); const c2 = await start(e, a.user.id, s.user.id); await e.call('POST', `/admin/team/staff/${s.user.id}/suspend`, e.sa.id);
	assert.equal((await e.call('GET', `${M}/conversations/${c2}/messages`, s.user.id)).status, 403); assert.equal((await send(e, a.user.id, c2, 'للموقوف')).status, 409);
	assert.equal((await e.call('GET', `${M}/conversations/${conv}/messages`, a.user.id)).json.data.messages.length, 1); // the other member still reads what was saved
});

test('PG messages: live socket - subscribe only for the permitted own account; events reach only the two members; access withdrawal cuts the open socket and a reconnect is refused; missed messages come back by HTTP after reconnect', opts, async () => {
	const e = await env(); const { Server } = await import('socket.io'); const { io: connect } = await import('socket.io-client'); const { setSocketServer } = await import('../utils/socket-registry'); const { registerAdminMessagesGateway } = await import('../sockets/admin-messages.gateway');
	const srv = http.createServer(); const io = new Server(srv); await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r())); const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
	io.use((s, next) => { const u = s.handshake.auth?.userId; if (u) { (s as any).userId = u; s.data = { ...(s.data ?? {}), userId: u }; } next(); });
	io.on('connection', s => registerAdminMessagesGateway(s)); setSocketServer(io);
	const clients: any[] = []; const open = async (userId?: string) => { const c = connect(url, { auth: userId ? { userId } : {}, transports: ['websocket'], reconnection: false, forceNew: true }); clients.push(c); await new Promise<void>((res, rej) => { c.on('connect', () => res()); c.on('connect_error', rej); }); return c; };
	const sub = (c: any) => new Promise<any>(r => c.emit('admin_messages_subscribe', {}, r)); const got = (c: any, ev: string) => { const l: any[] = []; c.on(ev, (p: any) => l.push(p)); return l; };
	try {
		const a = await member(e, 'ka'); const b = await member(e, 'kb'); const spy = await member(e, 'ks'); const np = await mkStaff(e, ['users.view'], 'kn'); const client = await e.mkUser('CLIENT_INDIVIDUAL', 'kc');
		const ca = await open(a.user.id), cb = await open(b.user.id), cs = await open(spy.user.id), cn = await open(np.user.id), cc = await open(client.id), anon = await open();
		assert.deepEqual(await sub(ca), { ok: true }); assert.deepEqual(await sub(cb), { ok: true }); assert.deepEqual(await sub(cs), { ok: true });
		assert.equal((await sub(cn)).ok, false); assert.equal((await sub(cc)).ok, false); assert.equal((await sub(anon)).code, 'UNAUTHENTICATED');
		const ga = got(ca, 'admin_message_new'), gb = got(cb, 'admin_message_new'), gs = got(cs, 'admin_message_new'), gn = got(cn, 'admin_message_new'), gc = got(cc, 'admin_message_new');
		const conv = await start(e, a.user.id, b.user.id); await send(e, a.user.id, conv, 'مباشر'); await new Promise(r => setTimeout(r, 150));
		assert.equal(ga.length, 1); assert.equal(gb.length, 1); assert.equal(gb[0].message.body, 'مباشر'); assert.equal(gs.length + gn.length + gc.length, 0); // nobody else hears it
		// a read on one tab is echoed to the same account's other tabs only
		const cb2 = await open(b.user.id); await sub(cb2); const sync = got(cb2, 'admin_read_sync'); const syncA = got(ca, 'admin_read_sync');
		await e.call('POST', `${M}/conversations/${conv}/read`, b.user.id, { upToSeq: gb[0].message.seq }); await new Promise(r => setTimeout(r, 150));
		assert.equal(sync.length, 1); assert.equal(sync[0].unread, 0); assert.equal(syncA.length, 0);
		// access withdrawal: the open socket is cut, the old tab's next request is 403, a reconnect cannot subscribe
		const closed = new Promise<void>(r => cb.on('disconnect', () => r())); const notice = got(cb, 'admin_access_changed');
		await deny(e, b.user.id, 'messages.use'); await Promise.race([closed, new Promise(r => setTimeout(r, 2000))]);
		assert.equal(cb.connected, false); assert.equal(notice.length, 1); assert.equal((await e.call('GET', `${M}/conversations`, b.user.id)).status, 403);
		const cb3 = await open(b.user.id); assert.equal((await sub(cb3)).code, 'ADMIN_PERMISSION_DENIED');
		// a message sent while a member was offline is NOT lost: after reconnecting the history request returns it
		const offline = await member(e, 'ko'); const c2 = await start(e, a.user.id, offline.user.id); const last = (await send(e, a.user.id, c2, 'قبل الانقطاع')).json.data.message.seq;
		await send(e, a.user.id, c2, 'أثناء الانقطاع'); const missed = (await e.call('GET', `${M}/conversations/${c2}/messages`, offline.user.id)).json.data.messages.filter((m: any) => BigInt(m.seq) > BigInt(last)); assert.deepEqual(missed.map((m: any) => m.body), ['أثناء الانقطاع']);
	} finally { for (const c of clients) c.close(); setSocketServer(null); await new Promise<void>(r => io.close(() => r())); }
});

test('PG messages: addPermissionToBaseRoles adds messages.use to the base roles ONLY - existing permissions and edits stay, custom roles are untouched, a personal DENY still wins, nobody is placed, each change is versioned and audited, a re-run changes nothing', opts, async () => {
	const e = await env(); const { ADMIN_ROLE_TEMPLATES } = await import('../config/admin-permissions'); const { adminRolesService } = await import('./admin-roles.service');
	await adminRolesService.ensureBaseRoles(e.sa.id);
	const names = ADMIN_ROLE_TEMPLATES.map(t => t.name);
	// start from the state dev has: base roles WITHOUT messages.use; one edited, one custom role next to them
	for (const n of names) { const r = await e.prisma.adminRole.findFirstOrThrow({ where: { name: n } }); await e.prisma.adminRole.update({ where: { id: r.id }, data: { permissions: r.permissions.filter(p => p !== 'messages.use') } }); }
	const edited = await e.prisma.adminRole.findFirstOrThrow({ where: { name: 'مشرف مالي' } }); await e.prisma.adminRole.update({ where: { id: edited.id }, data: { permissions: ['finance.read'], color: '#123456' } });
	const custom = await e.prisma.adminRole.create({ data: { name: `مخصص ${randomUUID().slice(0, 5)}`, nameKey: `custom-${randomUUID()}`, permissions: ['users.view'], createdById: e.sa.id } });
	const person = await e.mkUser('ADMIN', 'dn'); const support = await e.prisma.adminRole.findFirstOrThrow({ where: { name: 'مشرف دعم' } });
	const staff = await e.prisma.adminStaff.create({ data: { userId: person.id, roleId: support.id } }); await e.prisma.adminStaffOverride.create({ data: { staffId: staff.id, permission: 'messages.use', effect: 'DENY', createdById: e.sa.id } });
	const before = await e.prisma.adminRole.findMany({ where: { name: { in: names } } }); const staffBefore = await e.prisma.adminStaff.count(); const overridesBefore = await e.prisma.adminStaffOverride.count();
	const r1 = await adminRolesService.addPermissionToBaseRoles(e.sa.id, 'messages.use'); assert.equal(r1.updated.length, 5); assert.deepEqual(r1.missing, []);
	for (const b of before) {
		const a = await e.prisma.adminRole.findUniqueOrThrow({ where: { id: b.id } });
		assert.deepEqual(a.permissions, [...b.permissions, 'messages.use'].sort(), b.name); assert.equal(a.version, b.version + 1); assert.equal(a.color, b.color); assert.equal(a.description, b.description);
	}
	assert.deepEqual((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: edited.id } })).permissions, ['finance.read', 'messages.use']); // the edit survived, only the addition was made
	assert.deepEqual((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: custom.id } })).permissions, ['users.view']);
	assert.equal(await e.prisma.adminStaff.count(), staffBefore); assert.equal(await e.prisma.adminStaffOverride.count(), overridesBefore);
	assert.equal(await e.prisma.adminAccessAudit.count({ where: { action: 'ROLE_UPDATED', roleId: support.id } }) >= 1, true);
	const r2 = await adminRolesService.addPermissionToBaseRoles(e.sa.id, 'messages.use'); assert.equal(r2.updated.length, 0);
	for (const b of before) assert.equal((await e.prisma.adminRole.findUniqueOrThrow({ where: { id: b.id } })).version, b.version + 1);
	// the personal DENY still removes it for that person, while a colleague on the same role may message
	assert.equal((await e.call('GET', `${M}/directory`, person.id)).status, 403);
	const colleague = await e.mkUser('ADMIN', 'dc'); await e.prisma.adminStaff.create({ data: { userId: colleague.id, roleId: support.id } }); assert.equal((await e.call('GET', `${M}/directory`, colleague.id)).status, 200);
	await assert.rejects(adminRolesService.addPermissionToBaseRoles(e.sa.id, 'not.a.permission'));
});

test('PG messages: each of the five base roles can message and nothing more - same-role and cross-role conversations work, none of them reads another pair\'s conversation, and the directory / list expose only id, name and job title', opts, async () => {
	const e = await env(); const { ADMIN_ROLE_TEMPLATES } = await import('../config/admin-permissions');
	const people: Array<{ name: string; id: string }> = [];
	for (const t of ADMIN_ROLE_TEMPLATES) { const role = await e.call('POST', '/admin/team/roles', e.sa.id, { name: `${t.name} ${randomUUID().slice(0, 5)}`, permissions: [...t.permissions] }); assert.equal(role.status, 201); const u = await e.mkUser('ADMIN', 'r5'); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: role.json.data.id } }); people.push({ name: t.name, id: u.id }); }
	for (const p of people) assert.equal((await e.call('GET', `${M}/directory`, p.id)).status, 200, p.name);
	const first = people[0], last = people[people.length - 1], mid = people[2];
	const conv = await start(e, first.id, last.id); assert.equal((await send(e, first.id, conv, 'بين طرفين فقط')).status, 201);
	for (const p of people.filter(x => x.id !== first.id && x.id !== last.id)) { assert.equal((await e.call('GET', `${M}/conversations/${conv}/messages`, p.id)).status, 404, p.name); assert.equal((await send(e, p.id, conv, 'x')).status, 404); }
	const list = (await e.call('GET', `${M}/conversations`, mid.id)).json.data; assert.ok(!list.some((c: any) => c.id === conv));
	const dir = (await e.call('GET', `${M}/directory`, mid.id)).json.data as any[]; for (const d of dir) assert.deepEqual(Object.keys(d).sort(), ['name', 'role', 'userId']);
	const mine = (await e.call('GET', `${M}/conversations`, first.id)).json.data.find((c: any) => c.id === conv); assert.deepEqual(Object.keys(mine.counterpart).sort(), ['name', 'role', 'userId']);
	assert.ok(!/@|password|phone|email/i.test(JSON.stringify(mine) + JSON.stringify(dir))); // no e-mail / phone / credential field anywhere
	// none of them can use the team / roles / operations routes because of messaging
	const x = await e.call('GET', '/admin/team/roles', first.id); assert.equal(x.status, 403);
});
