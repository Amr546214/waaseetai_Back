import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRatingSchema } from '../dtos/rating.dto';

/** An in-memory review table + a mutex that behaves like pg_advisory_xact_lock (held until the transaction callback ends). */
function setup(t: TestContext, over: { serviceCatalogId?: string | null; contractStatus?: string; settledDispute?: boolean } = {}) {
	const reviews: any[] = [];
	const clientNotes: any[] = []; const providerNotes: any[] = [];
	let chain: Promise<void> = Promise.resolve();
	// The advisory lock is only taken when the service calls $executeRaw; the next holder waits until the holder's transaction callback ends.
	const makeTx = (hold: Promise<void>) => ({
		$executeRaw: async () => { const prev = chain; chain = prev.then(() => hold); await prev; return 1; },
		review: {
			findFirst: async ({ where }: any) => reviews.find(r => Object.entries(where).every(([k, v]) => r[k] === v || (v === null && r[k] == null))) ?? null,
			create: async ({ data }: any) => { await new Promise(r => setTimeout(r, 5)); const row = { id: `r${reviews.length + 1}`, ...data }; reviews.push(row); return row; },
			aggregate: async () => ({ _avg: { rating: reviews.filter(r => r.reviewerRole === 'CLIENT').reduce((a, r, _i, l) => a + r.rating / l.length, 0) } })
		},
		user: { update: async () => ({}) }, pointTransaction: { aggregate: async () => ({ _sum: { amount: 0 } }) },
		project: { count: async () => 1, findUnique: async () => ({ serviceCatalogId: over.serviceCatalogId ?? null }) }, providerGamification: { updateMany: async () => ({ count: 1 }) }
	});
	const prismaMock: any = {
		clientRequest: { findUnique: async () => null },
		dispute: { findFirst: async ({ where }: any) => (over.settledDispute && where.status === 'RESOLVED' && where.resolution?.in?.includes('SPLIT') ? { id: 'd-settled', resolution: 'SPLIT', resolvedAt: new Date() } : null) },
		review: { findFirst: async ({ where }: any) => reviews.filter(r => Object.entries(where).every(([k, v]) => r[k] === v || (v === null && r[k] == null))).slice(-1)[0] ?? null },
		contract: { findUnique: async () => ({ id: 'c1', providerId: 'prov', clientId: 'cli', projectId: 'p1', status: over.contractStatus ?? 'COMPLETED' }), findFirst: async () => ({ id: 'c1', providerId: 'prov', clientId: 'cli', projectId: 'p1' }) },
		project: { findUnique: async () => ({ serviceCatalogId: over.serviceCatalogId ?? null }) },
		projectStage: { findFirst: async () => ({ id: 'st1', status: 'APPROVED' }) },
		$transaction: async (fn: any) => {
			let done!: () => void; const mine = new Promise<void>(r => { done = r; });
			try { return await fn(makeTx(mine)); } finally { done(); }
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./admin-audit.service', { namedExports: { adminAudit: { listForEntity: async () => (over.settledDispute ? [{ context: { outcomeSummary: { outcome: 'SPLIT', refundToClient: 10, releaseToProvider: 15, platformCommission: 1.86, providerNet: 13.14 } } }] : []) } } });
	t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { ratingReceived: async (p: any) => { providerNotes.push(p); } } } });
	t.mock.module('./client-notifications.service', { namedExports: { clientNotifications: { send: async (n: any) => { clientNotes.push(n); } }, clientNotificationFor: { ratingReceived: (p: any) => ({ type: 'RATING_RECEIVED', ...p }) } } });
	return { reviews, clientNotes, providerNotes };
}

test('six parallel project ratings by the same client create exactly one review', async t => {
	const { reviews, providerNotes } = setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	const results = await Promise.allSettled(Array.from({ length: 6 }, () => svc.rateRequest('p1', 'cli', 'client', { rating: 4, comment: 'x' })));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(results.filter(r => r.status === 'rejected' && (r as any).reason.statusCode === 409).length, 5);
	assert.equal(reviews.length, 1);
	assert.equal(providerNotes.length, 1, 'the provider is notified once, not once per click');
});

test('parallel stage ratings create exactly one stage review', async t => {
	const { reviews } = setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.rateStage('p1', 'st1', 'cli', { rating: 5 })));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(reviews.filter(r => r.stageId === 'st1').length, 1);
});

test("a provider's rating of the client is stored separately, notifies the CLIENT, and does not notify the provider", async t => {
	const { reviews, clientNotes, providerNotes } = setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await svc.rateRequest('p1', 'prov', 'provider', { rating: 4 });
	await svc.rateRequest('p1', 'cli', 'client', { rating: 5 });
	assert.deepEqual(reviews.map(r => r.reviewerRole).sort(), ['CLIENT', 'PROVIDER']);
	assert.equal(clientNotes.length, 1); assert.equal(clientNotes[0].clientId, 'cli'); assert.equal(clientNotes[0].rating, 4);
	assert.equal(providerNotes.length, 1);
	await assert.rejects(() => svc.rateRequest('p1', 'prov', 'provider', { rating: 3 }), (e: any) => e.statusCode === 409);
});

test('a marketplace project rating is tied to the service so the service page shows it', async t => {
	const { reviews } = setup(t, { serviceCatalogId: 'svc-1' });
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	await new RatingService().rateRequest('p1', 'cli', 'client', { rating: 5 });
	assert.equal(reviews[0].serviceId, 'svc-1');
});

test('only the project client / provider may rate, in their own direction', async t => {
	setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await assert.rejects(() => svc.rateRequest('p1', 'stranger', 'client', { rating: 5 }), (e: any) => e.statusCode === 403);
	await assert.rejects(() => svc.rateRequest('p1', 'cli', 'provider', { rating: 5 }), (e: any) => e.statusCode === 403);
	await assert.rejects(() => svc.rateRequest('p1', 'prov', 'client', { rating: 5 }), (e: any) => e.statusCode === 403);
});

test('rating input: whole stars 1..5 only', () => {
	for (const bad of [0, 6, -1, 4.5, 2.2, NaN, '5', null, undefined]) assert.equal(createRatingSchema.safeParse({ rating: bad }).success, false, String(bad));
	for (const ok of [1, 2, 3, 4, 5]) assert.equal(createRatingSchema.safeParse({ rating: ok }).success, true);
	assert.equal(createRatingSchema.safeParse({ rating: 5, comment: 'x'.repeat(2001) }).success, false);
});

test('static: the stage-rating route is client-role only, like the project rating route', () => {
	const src = readFileSync('src/routes/client-requests.routes.ts', 'utf8');
	assert.match(src, /\/:id\/stages\/:stageId\/rating', authenticate, requireActiveUser, clientOnly, rateStage/);
	assert.match(src, /\/:id\/rate', authenticate, requireActiveUser, clientOnly, rateAsClient/);
	assert.match(readFileSync('src/services/rating.service.ts', 'utf8'), /pg_advisory_xact_lock/);
});

test('static: the public provider rating percentage keeps one decimal (4.33 of 5 must not display as 4.4)', () => {
	const src = readFileSync('src/services/provider-profile.service.ts', 'utf8');
	assert.match(src, /Math\.round\(\(baseRating \/ 5\) \* 1000\) \/ 10/);
	const pct = Math.round((13 / 3 / 5) * 1000) / 10;
	assert.equal(pct, 86.7);
	assert.equal((Math.round((pct / 20) * 10) / 10).toFixed(1), '4.3');
});

test('no rating before the project is completed, and an unfinished stage cannot be rated', async t => {
	setup(t, { contractStatus: 'ACTIVE' });
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await assert.rejects(() => svc.rateRequest('p1', 'cli', 'client', { rating: 5 }), (e: any) => e.statusCode === 400);
	await assert.rejects(() => svc.rateRequest('p1', 'prov', 'provider', { rating: 5 }), (e: any) => e.statusCode === 400);
});

test('a project settled by an admin FINANCIAL dispute decision cannot be rated by either side (project or stage), and no review / notification is created', async t => {
	const { reviews, clientNotes, providerNotes } = setup(t, { settledDispute: true });
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await assert.rejects(() => svc.rateRequest('p1', 'cli', 'client', { rating: 5 }), (e: any) => e.statusCode === 409 && /أُغلق المشروع بتسوية نزاع/.test(e.message));
	await assert.rejects(() => svc.rateRequest('p1', 'prov', 'provider', { rating: 5 }), (e: any) => e.statusCode === 409);
	await assert.rejects(() => svc.rateStage('p1', 'st1', 'cli', { rating: 5 }), (e: any) => e.statusCode === 409);
	assert.equal(reviews.length, 0); assert.equal(clientNotes.length, 0); assert.equal(providerNotes.length, 0);
});

test('a TEXT closure (no money moved) does not block rating: only financial outcomes count as an admin settlement', async t => {
	const { reviews } = setup(t, { settledDispute: false });
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	await new RatingService().rateRequest('p1', 'cli', 'client', { rating: 4 });
	assert.equal(reviews.length, 1);
});

test('rating status: eligible -> canRate; after saving -> ALREADY_RATED with the saved stars / comment / tags (read-only data), never a default', async t => {
	setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	const before = await svc.getStatus('p1', 'cli', 'client');
	assert.equal(before.canRate, true); assert.equal(before.review, null); assert.equal(before.reason, null);
	await svc.rateRequest('p1', 'cli', 'client', { rating: 3, comment: 'مقبول', tags: ['احترافية', 'تواصل ممتاز'] });
	const after = await svc.getStatus('p1', 'cli', 'client');
	assert.equal(after.canRate, false); assert.equal(after.reason, 'ALREADY_RATED');
	assert.equal(after.review.rating, 3); assert.equal(after.review.comment, 'مقبول'); assert.deepEqual(after.review.tags, ['احترافية', 'تواصل ممتاز']);
	// the other side has its OWN status: the provider has not rated the client yet
	const prov = await svc.getStatus('p1', 'prov', 'provider');
	assert.equal(prov.canRate, true); assert.equal(prov.review, null);
});

test('rating status: a stranger / the wrong side is refused 403 and learns nothing', async t => {
	setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await assert.rejects(() => svc.getStatus('p1', 'stranger', 'client'), (e: any) => e.statusCode === 403);
	await assert.rejects(() => svc.getStatus('p1', 'cli', 'provider'), (e: any) => e.statusCode === 403);
	await assert.rejects(() => svc.getStatus('p1', 'prov', 'client'), (e: any) => e.statusCode === 403);
});

test('rating status: an admin-settled project says so, hides the form, and keeps showing a rating that existed before the settlement', async t => {
	const { reviews } = setup(t, { settledDispute: true });
	reviews.push({ id: 'old', clientId: 'cli', providerId: 'prov', stageId: null, reviewerRole: 'CLIENT', projectId: 'p1', rating: 4, comment: 'قبل التسوية', tags: ['جودة عالية'], createdAt: new Date() });
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	const st = await svc.getStatus('p1', 'cli', 'client');
	assert.equal(st.canRate, false); assert.equal(st.adminSettled.label, 'أُغلق بتسوية نزاع');
	assert.deepEqual(st.adminSettled.distribution, { outcome: 'SPLIT', refundToClient: 10, releaseToProvider: 15, platformCommission: 1.86, providerNet: 13.14 }, 'the real executed distribution, never "the whole amount released"');
	assert.equal(st.review.rating, 4, 'history stays visible, separate from the eligibility of a NEW review');
	const prov = await svc.getStatus('p1', 'prov', 'provider');
	assert.equal(prov.reason, 'ADMIN_SETTLED'); assert.equal(prov.message, 'أُغلق المشروع بتسوية نزاع، ولا يتاح تقييمه'); assert.equal(prov.review, null);
});

test('tags: each side may only attach its own list, duplicates collapse, unknown tags are a 400 and nothing is created', async t => {
	const { reviews } = setup(t);
	const { RatingService } = await import(`./rating.service.ts?fixture=${Date.now()}-${Math.random()}`);
	const svc = new RatingService();
	await assert.rejects(() => svc.rateRequest('p1', 'cli', 'client', { rating: 5, tags: ['توصيات واضحة'] }), (e: any) => e.statusCode === 400); // a provider tag on a client review
	await assert.rejects(() => svc.rateRequest('p1', 'prov', 'provider', { rating: 5, tags: ['جودة عالية'] }), (e: any) => e.statusCode === 400);
	assert.equal(reviews.length, 0);
	await svc.rateRequest('p1', 'cli', 'client', { rating: 5, tags: ['جودة عالية', 'جودة عالية'] });
	assert.deepEqual(reviews[0].tags, ['جودة عالية']);
});
