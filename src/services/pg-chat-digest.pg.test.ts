import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// e-mail links always carry the site host (utils/site-url): the tests that look at the link configure it
process.env.FRONTEND_URL = 'https://dev.example.test';

/**
 * Batch D / chat-digest - REAL PostgreSQL tests (isolated DB only, same guard as pg-project-messages.pg.test.ts) for
 *  (a) one UNREAD chat notification per (recipient, conversation): concurrent-safe coalescing, count / unread counter / link for a general AND a project room,
 *  (b) the throttled e-mail digest: channel on/off, 15-minute window, only unread, nothing before activation, claim idempotency, hourly cap, failures.
 * Fake socket server + fake SMTP transport; synthetic data only.
 *
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_db DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_db \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-chat-digest.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

type Emitted = { rooms: string[]; event: string; payload: any };
const emitted: Emitted[] = [];
const mails: any[] = [];
let failMail = false;
if (enabled) {
	const fakeIo = { to(room: string) { const rec: string[] = [room]; const chain: any = { to(r: string) { rec.push(r); return chain; }, emit(event: string, payload: any) { emitted.push({ rooms: rec, event, payload }); } }; return chain; } };
	mock.module('../socket', { namedExports: { getIO: () => fakeIo, initSocketServer: () => fakeIo, ioInstance: fakeIo } });
	mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (m: any) => { if (failMail) throw new Error('smtp down'); mails.push(m); return { messageId: 'x', accepted: [m.to], rejected: [] }; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
	process.env.CHAT_DIGEST_BATCH = '100000';
}

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();
const MIN = 60_000;

async function world(opt: { providerEmail?: boolean; clientEmail?: boolean; project?: boolean } = {}) {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const mk = (role: 'CLIENT' | 'PROVIDER', n: string) => prisma.user.create({ data: { id: id(), accountType: role === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: n, email: `cd-${n}-${tag}@pg.test`, roles: [role], activeRole: role } });
	const [client, provider] = await Promise.all([mk('CLIENT', 'client'), mk('PROVIDER', 'prov')]);
	await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED', preferences: { notifChannels: opt.providerEmail ? ['push', 'email'] : ['push'] } } });
	if (opt.clientEmail) await prisma.notificationPreference.create({ data: { userId: client.id, settings: { email: true, inApp: true } } });
	const project = await prisma.project.create({ data: { id: id(), title: `QA ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	let contract: any = null; let room: any;
	if (opt.project) {
		contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 4, phasesCount: 1, status: 'ACTIVE', signedAt: new Date() } });
		const { ensureProjectRoom } = await import('./project-conversation.service');
		room = await ensureProjectRoom(prisma, contract);
	} else room = await prisma.conversation.create({ data: { projectId: project.id, clientId: client.id, providerId: provider.id } });
	return { prisma, client, provider, project, contract, room, tag };
}

const mkSocket = async (userId: string) => {
	const { ChatGateway } = await import('../sockets/chat.gateway');
	const handlers: Record<string, (d: any) => Promise<void> | void> = {};
	const socket: any = { id: `s-${userId}`, userId, on: (e: string, h: any) => { handlers[e] = h; }, join: () => undefined, leave: () => undefined, emit: () => undefined, to: () => ({ emit: () => undefined }) };
	new ChatGateway().register(socket, null);
	return handlers;
};
const send = (h: any, conversationId: string, content: string) => h.send_message({ data: { conversationId, content, type: 'TEXT' } });
const unreadChat = async (w: any, userId: string) => w.prisma.notification.findMany({ where: { userId, type: 'CHAT', isRead: false } });
const setActivation = async (prisma: any, at: Date) => { await prisma.$executeRaw`DELETE FROM chat_digest_activation`; await prisma.$executeRaw`INSERT INTO chat_digest_activation (id, enabled_at) VALUES ('default', ${at})`; };
const mailsTo = (email: string) => mails.filter(m => m.to === email);

test('pg: the isolated database is really a throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()`;
	assert.match(current_database, /^qa_iso/);
});

for (const kind of ['general', 'project'] as const) {
	test(`pg: ${kind} room - sequential messages keep ONE unread notification (latest text, exact count, same link), messages stay complete`, opts, async () => {
		const w = await world({ project: kind === 'project' });
		const h = await mkSocket(w.client.id);
		const before = emitted.length;
		for (let i = 1; i <= 5; i++) await send(h, w.room.id, `msg ${i}`);
		const rows = await unreadChat(w, w.provider.id);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].message, 'msg 5');
		assert.equal((rows[0].metadata as any).unreadCount, 5);
		assert.equal((rows[0].metadata as any).conversationId, w.room.id);
		assert.match(rows[0].title, /\(5\)$/);
		assert.equal(rows[0].actionUrl, kind === 'project' ? `/provider-overview/projects/active/progress/${w.contract.id}?tab=messages` : `/provider-overview/messages?conversationId=${w.room.id}`);
		assert.equal(await w.prisma.message.count({ where: { conversationId: w.room.id } }), 5); // messages complete
		assert.equal(await (await import('./notification.service')).notificationService.countUnread(w.provider.id), 1); // server counter exact
		const pushes = emitted.slice(before).filter(e => e.rooms.includes(`user_${w.provider.id}`));
		assert.deepEqual(pushes.map(p => p.event), ['new_notification', 'notification_updated', 'notification_updated', 'notification_updated', 'notification_updated']);
		assert.ok(pushes.every(p => p.payload.id === rows[0].id)); // an update re-uses the SAME id
	});

	test(`pg: ${kind} room - 30 CONCURRENT messages give exactly one unread row with count 30 and 30 messages`, opts, async () => {
		const w = await world({ project: kind === 'project' });
		const h = await mkSocket(w.client.id);
		await Promise.all(Array.from({ length: 30 }, (_, i) => send(h, w.room.id, `c${i}`)));
		const rows = await unreadChat(w, w.provider.id);
		assert.equal(rows.length, 1);
		assert.equal((rows[0].metadata as any).unreadCount, 30);
		assert.equal(await w.prisma.message.count({ where: { conversationId: w.room.id } }), 30);
		assert.equal(await w.prisma.notification.count({ where: { userId: w.provider.id, type: 'CHAT' } }), 1);
	});
}

test('pg: after the notification is read the next message creates a NEW row; the read one stays read; counter exact', opts, async () => {
	const w = await world();
	const h = await mkSocket(w.client.id);
	await send(h, w.room.id, 'a'); await send(h, w.room.id, 'b');
	const [first] = await unreadChat(w, w.provider.id);
	const { notificationService } = await import('./notification.service');
	await notificationService.markAsRead(first.id, w.provider.id);
	assert.equal(await notificationService.countUnread(w.provider.id), 0);
	await send(h, w.room.id, 'c');
	const rows = await unreadChat(w, w.provider.id);
	assert.equal(rows.length, 1); assert.notEqual(rows[0].id, first.id);
	assert.equal((rows[0].metadata as any).unreadCount, 1);
	assert.equal((await w.prisma.notification.findUnique({ where: { id: first.id } })).isRead, true);
	assert.equal(await notificationService.countUnread(w.provider.id), 1);
});

test('pg: a read that races concurrent messages never resurrects or loses a message: counter stays exact', opts, async () => {
	const w = await world();
	const h = await mkSocket(w.client.id);
	await send(h, w.room.id, 'seed');
	const [first] = await unreadChat(w, w.provider.id);
	const { notificationService } = await import('./notification.service');
	await Promise.all([notificationService.markAsRead(first.id, w.provider.id), ...Array.from({ length: 10 }, (_, i) => send(h, w.room.id, `r${i}`))]);
	const unread = await unreadChat(w, w.provider.id);
	assert.ok(unread.length <= 1);
	assert.equal(await notificationService.countUnread(w.provider.id), unread.length);
	assert.equal(await w.prisma.message.count({ where: { conversationId: w.room.id } }), 11);
});

test('pg: two conversations of one recipient keep two rows; the other role of the same pair is separate', opts, async () => {
	const a = await world(); const b = await world();
	const ha = await mkSocket(a.client.id);
	await send(ha, a.room.id, 'x'); await send(ha, a.room.id, 'y');
	const { notificationService } = await import('./notification.service');
	await notificationService.createOrCoalesceChat({ userId: a.provider.id, conversationId: b.room.id, title: 't', message: 'other conv', type: 'CHAT', metadata: { conversationId: b.room.id } });
	const rows = await unreadChat(a, a.provider.id);
	assert.equal(rows.length, 2);
});

// ───────────────────────────── digest ─────────────────────────────

test('pg digest: provider with e-mail ON gets ONE mail (count + latest preview); a second pass inside 15 min sends nothing', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	for (let i = 1; i <= 4; i++) await send(h, w.room.id, `hello ${i}`);
	const { runChatDigestOnce } = await import('./chat-digest.service');
	assert.equal(mailsTo(w.provider.email).length, 0); // never one mail per message
	const at = new Date(Date.now() + 10 * MIN);
	await runChatDigestOnce({ now: at });
	const m = mailsTo(w.provider.email);
	assert.equal(m.length, 1);
	assert.match(m[0].text, /4/); assert.match(m[0].text, /hello 4/); assert.match(m[0].html, /messages\?conversationId=/);
	await runChatDigestOnce({ now: new Date(at.getTime() + 5 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 1);
	// 20 min later but nothing NEW unread since the last digest: still nothing
	await runChatDigestOnce({ now: new Date(at.getTime() + 20 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 1);
	// a new unread message, then >15 min after the last digest and older than the min age: second digest, count = all unread
	await w.prisma.message.create({ data: { conversationId: w.room.id, senderId: w.client.id, content: 'hello 5', createdAt: new Date(at.getTime() + 25 * MIN) } }); // simulated clock: sent 25 min after the first digest
	await runChatDigestOnce({ now: new Date(at.getTime() + 40 * MIN) });
	const m2 = mailsTo(w.provider.email);
	assert.equal(m2.length, 2); assert.match(m2[1].text, /5 /); // 5 unread in total
});

test('pg digest: e-mail channel OFF (provider and client) sends nothing', opts, async () => {
	const w = await world({ providerEmail: false });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	await send(h, w.room.id, 'hi');
	const hp = await mkSocket(w.provider.id);
	await send(hp, w.room.id, 'hi back');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 0);
	assert.equal(mailsTo(w.client.email).length, 0);
});

test('pg digest: client with e-mail ON (link family /client-overview) is mailed with the client link', opts, async () => {
	const w = await world({ clientEmail: true, project: true });
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	const hp = await mkSocket(w.provider.id);
	await send(hp, w.room.id, 'from provider');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	const m = mailsTo(w.client.email);
	assert.equal(m.length, 1); assert.match(m[0].html, /\/client-overview\/projects\/.*tab=messages/);
});

test('pg digest: only unread - messages read in the chat produce no mail even though the notification row is still unread', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	await send(h, w.room.id, 'read me');
	const { chatService } = await import('./chat.service');
	await chatService.markAsRead(w.room.id, w.provider.id, 'PROVIDER');
	assert.equal((await unreadChat(w, w.provider.id)).length, 1);
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 0);
	// and a read notification is never mailed
	await send(h, w.room.id, 'second');
	const [row] = await unreadChat(w, w.provider.id);
	await (await import('./notification.service')).notificationService.markAsRead(row.id, w.provider.id);
	await runChatDigestOnce({ now: new Date(Date.now() + 30 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 0);
});

test('pg digest: nothing before activation - messages that existed before the switch-on are never mailed, later ones are, counting only the later ones', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await send(h, w.room.id, 'old 1'); await send(h, w.room.id, 'old 2');
	await new Promise(r => setTimeout(r, 30));
	const activation = new Date();
	await setActivation(w.prisma, activation);
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 0);
	await new Promise(r => setTimeout(r, 30));
	await send(h, w.room.id, 'new 1');
	await runChatDigestOnce({ now: new Date(Date.now() + 20 * MIN) });
	const m = mailsTo(w.provider.email);
	assert.equal(m.length, 1); assert.match(m[0].text, /new 1/); assert.doesNotMatch(m[0].text, /3 /); // 1 unread since activation, not 3
	// first run stores the activation itself (never moves earlier)
	await w.prisma.$executeRaw`DELETE FROM chat_digest_activation`;
	const { resolveChatDigestActivation } = await import('./chat-digest.service');
	const t0 = new Date(); const a1 = await resolveChatDigestActivation(t0); const a2 = await resolveChatDigestActivation(new Date(t0.getTime() + 5 * MIN));
	assert.equal(a1.getTime(), t0.getTime()); assert.equal(a2.getTime(), t0.getTime());
});

test('pg digest: too fresh (younger than the min age) is not mailed yet', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	await send(h, w.room.id, 'just now');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 1 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 0);
});

test('pg digest: claim idempotency - 8 concurrent passes (two instances / restarts) send exactly one mail', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	await send(h, w.room.id, 'one'); await send(h, w.room.id, 'two');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	const now = new Date(Date.now() + 10 * MIN);
	await Promise.all(Array.from({ length: 8 }, () => runChatDigestOnce({ now })));
	assert.equal(mailsTo(w.provider.email).length, 1);
	assert.equal(await w.prisma.chatDigestState.count({ where: { userId: w.provider.id } }), 1);
});

test('pg digest: a failing transport never throws, gives the slot back, and the next pass retries', opts, async () => {
	const w = await world({ providerEmail: true });
	const h = await mkSocket(w.client.id);
	await setActivation(w.prisma, new Date(Date.now() - 60 * MIN));
	await send(h, w.room.id, 'will fail');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	failMail = true;
	try { const r = await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) }); assert.ok(r.skipped['send-failed'] >= 1); } finally { failMail = false; }
	assert.equal(mailsTo(w.provider.email).length, 0);
	assert.equal(await w.prisma.chatDigestState.count({ where: { userId: w.provider.id } }), 0);
	await runChatDigestOnce({ now: new Date(Date.now() + 11 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 1);
});

test('pg digest: hourly cap per user (default 4) - the 5th conversation of one hour is not mailed', opts, async () => {
	const w = await world({ providerEmail: true });
	const prisma = w.prisma;
	await setActivation(prisma, new Date(Date.now() - 60 * MIN));
	const hc = await mkSocket(w.client.id);
	const convs = [w.room];
	for (let i = 0; i < 5; i++) {
		const p = await prisma.project.create({ data: { id: id(), title: `QA cap ${i}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: w.client.id, providerId: w.provider.id, status: 'IN_PROGRESS' } });
		convs.push(await prisma.conversation.create({ data: { projectId: p.id, clientId: w.client.id, providerId: w.provider.id } }));
	}
	for (const c of convs) await send(hc, c.id, 'ping');
	const { runChatDigestOnce } = await import('./chat-digest.service');
	await runChatDigestOnce({ now: new Date(Date.now() + 10 * MIN) });
	assert.equal(mailsTo(w.provider.email).length, 4);
});

test('pg digest: scheduler is OFF unless CHAT_DIGEST_EMAIL_ENABLED=true', opts, async () => {
	const { startChatDigestScheduler, stopChatDigestScheduler } = await import('./chat-digest.service');
	delete process.env.CHAT_DIGEST_EMAIL_ENABLED;
	assert.equal(startChatDigestScheduler(), false);
	process.env.CHAT_DIGEST_EMAIL_ENABLED = 'true';
	try { assert.equal(startChatDigestScheduler(), true); assert.equal(startChatDigestScheduler(), false); } finally { stopChatDigestScheduler(); delete process.env.CHAT_DIGEST_EMAIL_ENABLED; }
});
