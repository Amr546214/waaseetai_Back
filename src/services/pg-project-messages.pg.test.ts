import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL tests (isolated DB only, see pg-amend-dispute.pg.test.ts): the project message context (spec §10) and the amendment project events (§11).
 * Synthetic data only.
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);

async function world(over: { legacyRoom?: boolean } = {}) {
	const prisma = await db();
	const id = () => randomUUID();
	const tag = id().slice(0, 8);
	const mk = (role: 'CLIENT' | 'PROVIDER', n: string) => prisma.user.create({ data: { id: id(), accountType: role === 'CLIENT' ? 'CLIENT_INDIVIDUAL' : 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: n, email: `qa-${n}-${tag}@pg.test`, walletBalance: 500, roles: [role], activeRole: role } });
	const [client, provider, otherClient, otherProvider] = await Promise.all([mk('CLIENT', 'client'), mk('PROVIDER', 'prov'), mk('CLIENT', 'oclient'), mk('PROVIDER', 'oprov')]);
	const project = await prisma.project.create({ data: { id: id(), title: `QA ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 4, phasesCount: 2, status: 'ACTIVE', signedAt: new Date() } });
	await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, status: 'HELD', feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, providerCommissionSnapshotAt: new Date(), paymentMethod: 'WALLET', paymentReference: `PG-${tag}`, fundedAt: new Date() } });
	await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'S1', days: 2, percentage: 50, amount: 10, status: 'IN_PROGRESS' } });
	await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 2, title: 'S2', days: 2, percentage: 50, amount: 10, status: 'PENDING' } });
	const legacy = over.legacyRoom ? await prisma.conversation.create({ data: { projectId: project.id, clientId: client.id, providerId: provider.id } }) : null;
	if (legacy) await prisma.message.create({ data: { conversationId: legacy.id, senderId: client.id, content: 'old history' } });
	return { prisma, client, provider, otherClient, otherProvider, project, contract, legacy };
}

test('pg: 25 concurrent project-room opens create exactly ONE room, bound to the contract, and it is not in the general list', opts, async () => {
	const w = await world();
	const { ensureProjectRoom } = await import('./project-conversation.service');
	const { chatService } = await import('./chat.service');
	const rooms = await Promise.all(Array.from({ length: 25 }, () => ensureProjectRoom(w.prisma, w.contract)));
	assert.equal(new Set(rooms.map(r => r.id)).size, 1);
	assert.equal(await w.prisma.conversation.count({ where: { projectId: w.project.id } }), 1);
	assert.equal(rooms[0].kind, 'PROJECT');
	assert.equal(rooms[0].contractId, w.contract.id);
	assert.deepEqual(await chatService.getConversations(w.client.id, 'CLIENT'), []);
	assert.deepEqual(await chatService.getConversations(w.provider.id, 'PROVIDER'), []);
});

test('pg: an existing old shared room is reused as is (no second room, still GENERAL, history untouched) before any backfill', opts, async () => {
	const w = await world({ legacyRoom: true });
	const { ensureProjectRoom } = await import('./project-conversation.service');
	const rooms = await Promise.all(Array.from({ length: 10 }, () => ensureProjectRoom(w.prisma, w.contract)));
	assert.ok(rooms.every(r => r.id === w.legacy!.id && r.legacyShared && r.kind === 'GENERAL'));
	assert.equal(await w.prisma.conversation.count({ where: { projectId: w.project.id } }), 1);
	const row = await w.prisma.conversation.findUnique({ where: { id: w.legacy!.id } });
	assert.equal(row.kind, 'GENERAL'); assert.equal(row.contractId, null);
	assert.equal(await w.prisma.message.count({ where: { conversationId: w.legacy!.id } }), 1);
});

test('pg: forward-only auto link (flag) turns THIS contract\'s negotiation room into its project room in place; without the flag nothing changes', opts, async () => {
	const w = await world({ legacyRoom: true });
	const { ensureProjectRoom } = await import('./project-conversation.service');
	process.env.PROJECT_ROOM_LINK_CONTRACTS_FROM = new Date(Date.now() + 3600_000).toISOString(); // contract older than the cutoff -> untouched
	assert.equal((await ensureProjectRoom(w.prisma, w.contract)).legacyShared, true);
	process.env.PROJECT_ROOM_LINK_CONTRACTS_FROM = new Date(Date.now() - 3600_000).toISOString();
	try {
		const r = await ensureProjectRoom(w.prisma, w.contract);
		assert.equal(r.id, w.legacy!.id); assert.equal(r.kind, 'PROJECT'); assert.equal(r.legacyShared, false);
		assert.equal(await w.prisma.message.count({ where: { conversationId: w.legacy!.id } }), 1);
		const { chatService } = await import('./chat.service');
		assert.deepEqual(await chatService.getConversations(w.client.id, 'CLIENT'), []);
	} finally { delete process.env.PROJECT_ROOM_LINK_CONTRACTS_FROM; }
});

test('pg: ownership - non-members (other client, other provider, wrong role) are refused by REST helpers', opts, async () => {
	const w = await world();
	const svc = await import('./project-conversation.service');
	const { authorizeConversationForRole, chatService } = await import('./chat.service');
	const room = await svc.ensureProjectRoom(w.prisma, w.contract);
	for (const [u, role] of [[w.otherClient, 'CLIENT'], [w.otherProvider, 'PROVIDER'], [w.provider, 'CLIENT'], [w.client, 'PROVIDER'], [w.client, 'AFFILIATE']] as const) {
		await assert.rejects(() => svc.getProjectRoomFor(u.id, role, w.contract.id), /403|صلاحية/);
		await assert.rejects(() => svc.conversationContextFor(u.id, role, room.id));
		assert.equal(await authorizeConversationForRole(room.id, u.id, role), null);
		await assert.rejects(() => chatService.getMessages(room.id, u.id, 1, 20, role));
		await assert.rejects(() => chatService.sendMessage(u.id, { conversationId: room.id, content: 'x', type: 'TEXT' } as any, role));
		await assert.rejects(() => chatService.markAsRead(room.id, u.id, role));
	}
	const ok = await svc.getProjectRoomFor(w.client.id, 'CLIENT', w.project.id); // project id works as the key too
	assert.equal(ok.conversationId, room.id); assert.equal(ok.context, 'PROJECT');
	assert.equal((await svc.getProjectRoomFor(w.provider.id, 'PROVIDER', w.contract.id)).conversationId, room.id);
	const ctx = await svc.conversationContextFor(w.client.id, 'CLIENT', room.id);
	assert.equal(ctx.context, 'PROJECT'); assert.equal(ctx.url, `/client-overview/projects/${w.contract.id}?tab=messages`);
});

test('pg: both parties share one history; unread counts and read state are per context', opts, async () => {
	const w = await world();
	const svc = await import('./project-conversation.service');
	const { chatService } = await import('./chat.service');
	const room = await svc.ensureProjectRoom(w.prisma, w.contract);
	await chatService.sendMessage(w.client.id, { conversationId: room.id, content: 'hello', type: 'TEXT' } as any, 'CLIENT');
	await chatService.sendMessage(w.provider.id, { conversationId: room.id, content: 'hi', type: 'TEXT' } as any, 'PROVIDER');
	assert.equal((await svc.getProjectRoomFor(w.provider.id, 'PROVIDER', w.contract.id)).unreadCount, 1);
	const asClient = await chatService.getMessages(room.id, w.client.id, 1, 20, 'CLIENT');
	const asProvider = await chatService.getMessages(room.id, w.provider.id, 1, 20, 'PROVIDER');
	assert.deepEqual(asClient.data.map((m: any) => m.id), asProvider.data.map((m: any) => m.id));
	assert.equal((await svc.getProjectRoomFor(w.provider.id, 'PROVIDER', w.contract.id)).unreadCount, 0);
});

test('pg: socket gateway - a non-member cannot join, send, mark read, type or call in a project room; members get the project room name', opts, async () => {
	const w = await world();
	const svc = await import('./project-conversation.service');
	const { ChatGateway } = await import('../sockets/chat.gateway');
	const room = await svc.ensureProjectRoom(w.prisma, w.contract);
	const mkSocket = (userId: string) => {
		const handlers: Record<string, (d: any) => Promise<void> | void> = {}; const joined: string[] = []; const emitted: any[] = [];
		const socket: any = { id: `s-${userId}`, userId, on: (e: string, h: any) => { handlers[e] = h; }, join: (r: string) => joined.push(r), leave: () => undefined, emit: (e: string, d: any) => emitted.push([e, d]), to: () => ({ emit: (e: string, d: any) => emitted.push(['room:' + e, d]) }) };
		new ChatGateway().register(socket, null);
		return { handlers, joined, emitted };
	};
	for (const u of [w.otherClient, w.otherProvider]) {
		const s = mkSocket(u.id);
		await s.handlers.join_conversation({ conversationId: room.id });
		assert.deepEqual(s.joined, []); assert.ok(s.emitted.some(e => e[0] === 'chat_error'));
		await s.handlers.send_message({ data: { conversationId: room.id, content: 'intrude', type: 'TEXT' } });
		assert.ok(s.emitted.filter(e => e[0] === 'chat_error').length >= 2);
		await s.handlers.mark_as_read({ conversationId: room.id });
		await s.handlers.typing_status({ conversationId: room.id, isTyping: true });
		await s.handlers.call_user({ conversationId: room.id });
		assert.ok(!s.emitted.some(e => String(e[0]).startsWith('room:')));
	}
	assert.equal(await w.prisma.message.count({ where: { conversationId: room.id } }), 0);
	// wrong role (the provider acting as CLIENT) is refused too
	await w.prisma.user.update({ where: { id: w.provider.id }, data: { roles: ['PROVIDER', 'CLIENT'], activeRole: 'CLIENT' } });
	const wrong = mkSocket(w.provider.id);
	await wrong.handlers.join_conversation({ conversationId: room.id });
	assert.deepEqual(wrong.joined, []);
	await w.prisma.user.update({ where: { id: w.provider.id }, data: { activeRole: 'PROVIDER' } });
	const member = mkSocket(w.client.id);
	await member.handlers.join_conversation({ conversationId: room.id });
	assert.deepEqual(member.joined, [`project_room_${w.contract.id}`]);
	await member.handlers.send_message({ data: { conversationId: room.id, content: 'real', type: 'TEXT' } });
	const n = await w.prisma.notification.findFirst({ where: { userId: w.provider.id, type: 'CHAT' } });
	assert.equal(n.actionUrl, `/provider-overview/projects/active/progress/${w.contract.id}?tab=messages`);
	assert.equal((n.metadata as any).context, 'PROJECT');
});

test('pg: upload for a conversation is refused for non-members', opts, async () => {
	const w = await world();
	const svc = await import('./project-conversation.service');
	const { chatController } = await import('../controllers/chat.controller');
	const room = await svc.ensureProjectRoom(w.prisma, w.contract);
	const call = (user: any) => new Promise<any>(resolve => chatController.uploadAttachment({ user, body: { conversationId: room.id, fileData: 'data:text/plain;base64,AA==' } } as any, { status: () => ({ json: () => resolve(null) }) } as any, (e: any) => resolve(e)));
	const e1 = await call({ id: w.otherClient.id, activeRole: 'CLIENT' });
	assert.equal(e1?.statusCode, 403);
	const e2 = await call({ id: w.otherProvider.id, activeRole: 'PROVIDER' });
	assert.equal(e2?.statusCode, 403);
});

test('pg: project events are idempotent under concurrency and keep a deterministic order', opts, async () => {
	const w = await world();
	const { appendProjectEvent } = await import('./project-conversation.service');
	const results = await Promise.all(Array.from({ length: 12 }, () => appendProjectEvent({ contractId: w.contract.id, eventKey: `k:${w.contract.id}:a`, actorId: w.client.id, text: 'event A', event: 'T' })));
	assert.equal(results.filter(r => r.created).length, 1);
	const first = await appendProjectEvent({ contractId: w.contract.id, eventKey: `k:${w.contract.id}:b`, actorId: w.client.id, text: 'event B', event: 'T' });
	const second = await appendProjectEvent({ contractId: w.contract.id, eventKey: `k:${w.contract.id}:c`, actorId: w.client.id, text: 'event C', event: 'T', notBefore: first.createdAt });
	assert.ok(second.createdAt! > first.createdAt!);
	assert.equal(await w.prisma.message.count({ where: { eventKey: { startsWith: `k:${w.contract.id}` } } }), 3);
});

test('pg: amendment lifecycle writes one truthful event per state change; retries add nothing; money path unchanged; list is newest first', opts, async () => {
	const w = await world();
	const { projectAmendmentService } = await import('./project-amendment.service');
	const texts = async () => (await w.prisma.message.findMany({ where: { eventKey: { startsWith: 'amendment:' }, conversation: { projectId: w.project.id } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m: any) => m.content as string);

	// provider raises a duration change 4 -> 6
	const a1 = await projectAmendmentService.createProviderAmendment(w.provider.id, w.project.id, { title: 'مدة', type: 'DURATION', durationDeltaDays: 2 });
	assert.deepEqual(await texts(), ['طلب مقدم الخدمة تعديل المدة من 4 إلى 6 أيام — «مدة»']);
	// client answers: accepted then applied, in that order, applied only after the commit
	await projectAmendmentService.respondToAmendment(w.client.id, a1.id, 'approve');
	const t1 = await texts();
	assert.equal(t1.length, 3);
	assert.match(t1[1], /وافق العميل/); assert.match(t1[2], /طُبّق التعديل على العقد: المدة من 4 إلى 6 أيام/);
	assert.equal((await w.prisma.contract.findUnique({ where: { id: w.contract.id } })).durationDays, 6);
	// a retried approve is refused (409) and adds no event
	await assert.rejects(() => projectAmendmentService.respondToAmendment(w.client.id, a1.id, 'approve'));
	assert.equal((await texts()).length, 3);

	// client raises, provider rejects; client raises, cancels
	const a2 = await projectAmendmentService.createAmendment(w.client.id, w.contract.id, { title: 'نطاق', type: 'SCOPE', description: 'إضافة صفحة' });
	await projectAmendmentService.respondToAmendmentAsProvider(w.provider.id, a2.id, 'reject');
	const a3 = await projectAmendmentService.createAmendment(w.client.id, w.contract.id, { title: 'ميزانية', type: 'BUDGET', budgetDelta: 5 });
	await projectAmendmentService.cancelAmendment(w.client.id, 'CLIENT', a3.id);
	const all = await texts();
	assert.equal(all.length, 3 + 2 + 2, 'approved: created+accepted+applied; rejected: created+rejected; cancelled: created+cancelled');
	assert.ok(all.some(t => /رفض مقدم الخدمة/.test(t)) && all.some(t => /ألغى العميل/.test(t)));
	assert.ok(!all.some(t => /\d{6}/.test(t)), 'no code-like number in any event text');
	// no event for a rejected / cancelled one claims "applied"
	assert.equal(all.filter(t => /طُبّق/.test(t)).length, 1);

	// newest first, deterministic
	const list = await projectAmendmentService.listAmendments(w.client.id);
	assert.deepEqual(list.map((r: any) => r.id), [a3.id, a2.id, a1.id]);
	const plist = await projectAmendmentService.listProviderAmendments(w.provider.id, w.project.id);
	assert.deepEqual(plist.map((r: any) => r.id), [a3.id, a2.id, a1.id]);
});
