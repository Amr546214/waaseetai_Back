import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Batch B / T5 — REAL PostgreSQL tests for (1) notification delivery (once, only after the operation succeeded, no phantom on failure, no duplicate on retry or
 * concurrent windows, channel preferences really gate the real-time push and the e-mail, the `since` recovery read + the exact unread counter) and (2) the ratings
 * read model (the counterpart's review, per-stage reviews, the provider's read of a stage rating, no final/stage mixing, unpublished = both parties only).
 *
 * Runs ONLY against an isolated throw-away database (same guard as pg-reviews.pg.test.ts). All data is synthetic.
 *
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_t5"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t5 npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t5 DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_t5 \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-notifications-ratings-t5.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

// A fake socket server and a fake SMTP transport: what would really be pushed / mailed is recorded, nothing leaves the process.
type Emitted = { rooms: string[]; event: string; payload: any };
const emitted: Emitted[] = [];
const mails: any[] = [];
if (enabled) {
	const fakeIo = { to(room: string) { const rec: string[] = [room]; const chain: any = { to(r: string) { rec.push(r); return chain; }, emit(event: string, payload: any) { emitted.push({ rooms: rec, event, payload }); } }; return chain; } };
	mock.module('../socket', { namedExports: { getIO: () => fakeIo, initSocketServer: () => fakeIo, ioInstance: fakeIo } });
	mock.module('../utils/mail.transporter', { namedExports: { mailTransporter: { sendMail: async (m: any) => { mails.push(m); return { messageId: 'x', accepted: [m.to], rejected: [] }; } }, getOtpEmailTemplate: () => '', getPasswordResetEmailTemplate: () => '' } });
}

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const code = (e: any) => e?.statusCode;
const ns = async () => (await import('./notification.service')).notificationService;
const rating = async () => (await import('./rating.service')).ratingService;
const countNotes = async (userId: string, type?: string) => (await db()).notification.count({ where: { userId, ...(type ? { type } : {}) } });
const pushesFor = (userId: string) => emitted.filter(e => e.event === 'new_notification' && e.rooms.includes(`user_${userId}`));

async function seed(over: { completed?: boolean; stageStatuses?: string[] } = {}) {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'Cl', lastName: tag, email: `t5-client-${tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	await prisma.clientProfile.create({ data: { id: id(), userId: client.id, firstName: 'Cl', lastName: tag } });
	const stranger = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'Str', lastName: tag, email: `t5-str-${tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	const provider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'Pr', lastName: tag, email: `t5-prov-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED' } });
	const otherProvider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'Other', lastName: tag, email: `t5-prov2-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const completed = over.completed ?? true;
	const project = await prisma.project.create({ data: { id: id(), title: `Proj ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: completed ? 'COMPLETED' : 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 2, status: completed ? 'COMPLETED' : 'ACTIVE', signedAt: new Date() } });
	const statuses = over.stageStatuses ?? ['APPROVED', 'APPROVED'];
	const stages: any[] = [];
	for (let i = 0; i < statuses.length; i++) stages.push(await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: i + 1, title: `S${i + 1}`, days: 7, percentage: 100 / statuses.length, amount: 20 / statuses.length, status: statuses[i], ...(statuses[i] === 'APPROVED' ? { approvedAt: new Date() } : {}) } }));
	return { prisma, tag, client, stranger, provider, otherProvider, project, contract, stages };
}

test('pg: the isolated database is really a throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.match(current_database, /^qa_iso_/);
});

// ── notifications: once, after success, no phantom, no duplicate ────────────────────────────────────────────────────────────
test('pg: a client rating is notified ONCE to the provider, after it was saved, and the link opens the rating inside the project', opts, async () => {
	const w = await seed(); const svc = await rating();
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 5, comment: 'ممتاز', publish: false });
	const rows = await w.prisma.notification.findMany({ where: { userId: w.provider.id, type: 'RATING_RECEIVED' } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].actionUrl, `/provider-overview/projects/${w.project.id}/rating`);
	assert.equal((rows[0].metadata as any).projectId, w.project.id);
	// the retry (second click / second window) is a 409 and creates NO second notification
	await assert.rejects(svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 5 }), (e: any) => code(e) === 409);
	assert.equal(await countNotes(w.provider.id, 'RATING_RECEIVED'), 1);
});

test('pg: parallel windows rating the same project / stage create exactly ONE review and ONE notification', opts, async () => {
	const w = await seed(); const svc = await rating();
	const results = await Promise.allSettled([1, 2, 3, 4, 5].map(n => svc.rateRequest(w.project.id, w.client.id, 'client', { rating: ((n % 5) + 1) as 1 })));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(await countNotes(w.provider.id, 'RATING_RECEIVED'), 1);
	const stageRes = await Promise.allSettled([1, 2, 3].map(() => svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 4 })));
	assert.equal(stageRes.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(await countNotes(w.provider.id, 'RATING_RECEIVED'), 2, 'one for the project, one for the stage');
	const stageNote = (await w.prisma.notification.findMany({ where: { userId: w.provider.id, type: 'RATING_RECEIVED' } })).find((n: any) => n.title === 'تقييم جديد على مرحلة');
	assert.equal(stageNote.actionUrl, `/provider-overview/projects/active/progress/${w.project.id}`);
});

test('pg: a FAILED operation leaves no phantom notification (not completed, not the owner, wrong tag)', opts, async () => {
	const open = await seed({ completed: false }); const svc = await rating();
	await assert.rejects(svc.rateRequest(open.project.id, open.client.id, 'client', { rating: 5 }), (e: any) => code(e) === 400);
	const done = await seed();
	await assert.rejects(svc.rateRequest(done.project.id, done.stranger.id, 'client', { rating: 5 }), (e: any) => code(e) === 403);
	await assert.rejects(svc.rateRequest(done.project.id, done.client.id, 'client', { rating: 5, tags: ['وسم غير موجود'] }), (e: any) => code(e) === 400);
	for (const w of [open, done]) assert.equal(await countNotes(w.provider.id) + await countNotes(w.client.id), 0);
});

test('pg: the provider rating the client notifies the CLIENT once, with a link to the project rating page', opts, async () => {
	const w = await seed(); const svc = await rating();
	await svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 4, comment: 'عميل متعاون' });
	await assert.rejects(svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 4 }), (e: any) => code(e) === 409);
	const rows = await w.prisma.notification.findMany({ where: { userId: w.client.id, type: 'RATING_RECEIVED' } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].actionUrl, `/client-overview/projects/${w.project.id}/rating`);
});

// ── channel preferences ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: client channels: in-app OFF -> stored but NOT pushed; e-mail ON -> mailed once; defaults -> pushed, not mailed; CHAT is never mailed', opts, async () => {
	const w = await seed(); const svc = await ns();
	const input = (userId: string, type = 'GENERAL') => ({ userId, title: 'عنوان', message: 'نص', type, actionUrl: '/client-overview/projects/active' });
	// defaults
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit(input(w.client.id));
	assert.equal(pushesFor(w.client.id).length, 1); assert.equal(mails.length, 0);
	// in-app off
	await w.prisma.notificationPreference.create({ data: { userId: w.client.id, settings: { inApp: false } } });
	emitted.length = 0;
	await svc.createAndEmit(input(w.client.id));
	assert.equal(pushesFor(w.client.id).length, 0, 'disabled channel must not push');
	assert.equal(await countNotes(w.client.id), 2, 'the inbox row is always stored');
	// e-mail on (and in-app back on)
	await w.prisma.notificationPreference.update({ where: { userId: w.client.id }, data: { settings: { inApp: true, email: true } } });
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit(input(w.client.id));
	await sleep(50);
	assert.equal(pushesFor(w.client.id).length, 1); assert.equal(mails.length, 1);
	assert.equal(mails[0].to, w.client.email);
	// a chat message: pushed, never one e-mail per message
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit({ ...input(w.client.id, 'CHAT'), actionUrl: '/client-overview/messages?conversationId=c1' });
	await sleep(50);
	assert.equal(pushesFor(w.client.id).length, 1); assert.equal(mails.length, 0);
});

test('pg: provider channels: push removed from notifChannels -> no real-time push; email chosen -> one mail; rooms are the recipient\'s own only', opts, async () => {
	const w = await seed(); const svc = await ns();
	await w.prisma.providerProfile.update({ where: { userId: w.provider.id }, data: { preferences: { notifChannels: ['email'] } } });
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit({ userId: w.provider.id, title: 't', message: 'm', type: 'GENERAL', actionUrl: '/provider-overview/offers' });
	await sleep(50);
	assert.equal(pushesFor(w.provider.id).length, 0); assert.equal(mails.length, 1);
	await w.prisma.providerProfile.update({ where: { userId: w.provider.id }, data: { preferences: { notifChannels: ['push'] } } });
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit({ userId: w.provider.id, title: 't', message: 'm', type: 'GENERAL', actionUrl: '/provider-overview/offers' });
	assert.equal(mails.length, 0);
	const pushes = emitted.filter(e => e.event === 'new_notification');
	assert.equal(pushes.length, 1);
	// no room of anybody else: only this user's two personal rooms
	assert.deepEqual([...pushes[0].rooms].sort(), [`project_owner_${w.provider.id}`, `user_${w.provider.id}`].sort());
});

test('pg: marketer per-event switch OFF -> a REFERRAL_JOINED notification is stored but neither pushed nor mailed', opts, async () => {
	const w = await seed(); const svc = await ns();
	await w.prisma.notificationPreference.create({ data: { userId: w.client.id, settings: { marketer_new_referral: false, email: true } } });
	emitted.length = 0; mails.length = 0;
	await svc.createAndEmit({ userId: w.client.id, title: 't', message: 'm', type: 'REFERRAL_JOINED', actionUrl: '/marketer-overview/referrals' });
	await sleep(50);
	assert.equal(pushesFor(w.client.id).length, 0); assert.equal(mails.length, 0);
	assert.equal(await countNotes(w.client.id, 'REFERRAL_JOINED'), 1);
});

// ── recovery read + counters ───────────────────────────────────────────────────────────────────────────────────────────────
test('pg: the list supports `since` (recovery after a reconnect) and the unread counter is the real total, per user only', opts, async () => {
	const w = await seed(); const svc = await ns();
	const { notificationsController } = await import('../controllers/notifications.controller');
	const mk = async (userId: string, n: number) => { for (let i = 0; i < n; i++) { await svc.createAndEmit({ userId, title: `n${i}`, message: 'm', type: 'GENERAL' }); await sleep(5); } };
	await mk(w.client.id, 3);
	const first = await svc.getUserNotifications(w.client.id);
	const newest = first[0].createdAt;
	await sleep(10);
	await mk(w.client.id, 2);
	await mk(w.provider.id, 4); // somebody else's: never in this user's recovery
	const call = async (userId: string, query: any) => { let body: any; let status = 200; await notificationsController.getNotifications({ user: { id: userId }, query } as any, { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } } as any); return { status, body }; };
	const recovered = await call(w.client.id, { since: newest });
	assert.equal(recovered.status, 200);
	assert.equal(recovered.body.data.length, 3, 'the newest already-held row (same-ms tie safe) + the 2 missed ones');
	assert.ok(recovered.body.data.every((n: any) => n.userId === w.client.id));
	assert.equal(recovered.body.unreadCount, 5);
	assert.equal((await call(w.provider.id, {})).body.unreadCount, 4);
	assert.equal((await call(w.client.id, { since: 'not-a-date' })).status, 400);
	// read state moves the counter, and only for the owner
	await svc.markAsRead(first[0].id, w.client.id);
	assert.equal((await call(w.client.id, {})).body.unreadCount, 4);
	await assert.rejects(svc.markAsRead(first[1].id, w.provider.id), (e: any) => code(e) === 404);
	assert.equal((await call(w.client.id, { unreadOnly: 'true' })).body.data.length, 4);
});

// ── provider signing -> client notification ─────────────────────────────────────────────────────────────────────────────────
test('pg: the provider signing the contract notifies the client ONCE (after commit); a repeat / concurrent signature adds nothing', opts, async () => {
	const w = await seed({ completed: false });
	const prisma = w.prisma;
	await prisma.contract.update({ where: { id: w.contract.id }, data: { status: 'PENDING_PROVIDER_SIGNATURE', providerSignedAt: null, signedAt: null } });
	await prisma.escrow.create({ data: { id: id(), projectId: w.project.id, amount: 20, status: 'HELD', fundedAt: new Date() } });
	const proposal = await prisma.projectProposal.create({ data: { id: id(), projectId: w.project.id, providerId: w.provider.id, title: 't', message: 'm', totalPrice: 20, deliveryDays: 10, status: 'PENDING_SIGNATURE' } });
	const { signContract } = await import('../controllers/provider.controller');
	const run = async () => { let status = 200; let body: any; await signContract({ user: { id: w.provider.id }, params: { id: proposal.id }, body: { agreedTerms: { accepted: true } } } as any, { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } } as any, (e: any) => { status = e?.statusCode ?? 500; body = e; }); return status; };
	const statuses = await Promise.all([run(), run(), run()]);
	assert.equal(statuses.filter(s => s === 200).length, 1, JSON.stringify(statuses));
	const rows = await prisma.notification.findMany({ where: { userId: w.client.id, type: 'CONTRACT_SIGNED' } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].actionUrl, `/client-overview/projects/${w.project.id}`);
	assert.equal(await run(), 409);
	assert.equal(await countNotes(w.client.id, 'CONTRACT_SIGNED'), 1);
});

// ── ratings read model ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: the counterpart\'s review is readable by BOTH parties (published or not), only by them, and is never the same slot as "my review"', opts, async () => {
	const w = await seed(); const svc = await rating();
	// nothing rated yet: no counterpart anywhere
	assert.equal((await svc.getStatus(w.project.id, w.client.id, 'client')).counterpart, null);
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 5, comment: 'خدمة رائعة', tags: ['جودة عالية'], publish: false });
	const providerView = await svc.getStatus(w.contract.id, w.provider.id, 'provider');
	assert.equal(providerView.review, null, 'the provider has not rated: its own slot stays empty');
	assert.equal(providerView.canRate, true);
	assert.equal(providerView.counterpart?.rating, 5);
	assert.equal(providerView.counterpart?.comment, 'خدمة رائعة');
	assert.equal(providerView.counterpart?.isPublic, false, 'unpublished is still shown to the other party');
	assert.equal(providerView.counterpart?.reviewerRole, 'CLIENT');
	// the client sees only its own review, no counterpart until the provider rates
	const clientView = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.equal(clientView.review?.rating, 5); assert.equal(clientView.counterpart, null);
	await svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 3, comment: 'تعاون جيد', publish: true });
	const clientView2 = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.equal(clientView2.counterpart?.rating, 3); assert.equal(clientView2.counterpart?.reviewerRole, 'PROVIDER');
	assert.equal(clientView2.review?.rating, 5, 'the client\'s own review is unchanged');
	// a stranger gets nothing (403), and another provider too
	await assert.rejects(svc.getStatus(w.project.id, w.stranger.id, 'client'), (e: any) => code(e) === 403);
	await assert.rejects(svc.getStatus(w.project.id, w.otherProvider.id, 'provider'), (e: any) => code(e) === 403);
	// the provider\'s rating of the client never entered the provider\'s own aggregate
	assert.equal(await w.prisma.review.count({ where: { providerId: w.provider.id, reviewerRole: 'PROVIDER' } }), 1);
});

test('pg: stage reviews are listed separately (stageReviews) and never fill the final slots; the provider reads a stage rating read-only; strangers are refused', opts, async () => {
	const w = await seed(); const svc = await rating();
	await svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 2, comment: 'متأخر قليلًا', publish: false });
	const clientProject = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.equal(clientProject.review, null, 'a stage review does not make the project look rated');
	assert.equal(clientProject.canRate, true);
	assert.equal(clientProject.stageReviews?.length, 1);
	assert.equal(clientProject.stageReviews?.[0].stageId, w.stages[0].id);
	const providerProject = await svc.getStatus(w.project.id, w.provider.id, 'provider');
	assert.equal(providerProject.counterpart, null, 'a stage review is not the final counterpart review');
	assert.equal(providerProject.stageReviews?.[0].rating, 2);
	assert.equal(providerProject.stageReviews?.[0].isPublic, false);
	// the provider's stage read
	const stage0 = await svc.getProviderStageStatus(w.project.id, w.stages[0].id, w.provider.id);
	assert.equal(stage0.scope, 'STAGE'); assert.equal(stage0.canRate, false); assert.equal(stage0.reason, 'NOT_RATER');
	assert.equal(stage0.review, null); assert.equal(stage0.counterpart?.rating, 2); assert.equal(stage0.counterpart?.comment, 'متأخر قليلًا');
	const stage1 = await svc.getProviderStageStatus(w.contract.id, w.stages[1].id, w.provider.id);
	assert.equal(stage1.counterpart, null, 'the other stage is unrated: nothing is borrowed from stage 1');
	await assert.rejects(svc.getProviderStageStatus(w.project.id, w.stages[0].id, w.otherProvider.id), (e: any) => code(e) === 403);
	await assert.rejects(svc.getProviderStageStatus(w.project.id, w.stages[0].id, w.client.id), (e: any) => code(e) === 403);
	await assert.rejects(svc.getProviderStageStatus(w.project.id, id(), w.provider.id), (e: any) => code(e) === 404);
	await assert.rejects(svc.getProviderStageStatus(id(), w.stages[0].id, w.provider.id), (e: any) => code(e) === 404);
	// the stage status of the client side keeps its own contract
	const clientStage = await svc.getStageStatus(w.project.id, w.stages[0].id, w.client.id);
	assert.equal(clientStage.review?.rating, 2); assert.equal(clientStage.canRate, false); assert.equal(clientStage.reason, 'ALREADY_RATED');
});

test('pg: a financially settled project opens no new rating but keeps the history readable to both parties', opts, async () => {
	const w = await seed(); const svc = await rating();
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 4 });
	await w.prisma.dispute.create({ data: { id: id(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, status: 'RESOLVED', reason: 'r', description: 'd', resolution: 'SPLIT', resolvedAt: new Date() } });
	const provider = await svc.getStatus(w.project.id, w.provider.id, 'provider');
	assert.equal(provider.canRate, false); assert.equal(provider.reason, 'ADMIN_SETTLED');
	assert.equal(provider.counterpart?.rating, 4, 'history stays readable');
	await assert.rejects(svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 5 }), (e: any) => code(e) === 409);
	const stage = await svc.getProviderStageStatus(w.project.id, w.stages[0].id, w.provider.id);
	assert.equal(stage.adminSettled?.disputeId != null, true);
	assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), 1, 'nothing was deleted or added');
});

test('pg: PUBLIC readers ignore the unpublished counterpart review (client public profile) while the internal level gate still counts the client review', opts, async () => {
	const w = await seed(); const svc = await rating();
	await svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 1, publish: false });
	const { publicClientReviewsWhere } = await import('./review-visibility');
	assert.equal(await w.prisma.review.count({ where: publicClientReviewsWhere(w.client.id) }), 0);
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 2, publish: false });
	const { publicProviderReviewsWhere } = await import('./review-visibility');
	assert.equal(await w.prisma.review.count({ where: publicProviderReviewsWhere(w.provider.id) }), 0);
	const user = await w.prisma.user.findUnique({ where: { id: w.provider.id }, select: { ratingAverage: true } });
	assert.equal(user.ratingAverage, 2, 'internal average (level gate) keeps counting it by design');
});
