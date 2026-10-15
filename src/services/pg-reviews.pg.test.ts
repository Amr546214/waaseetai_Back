import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * REAL PostgreSQL tests for the review/rating system: duplicates + concurrency, ownership, settled projects, stage ratings, publication (privacy through the PUBLIC
 * readers), public vs internal averages, and the two review migrations (old rows unchanged, self-protecting rollbacks).
 *
 * Runs ONLY against an isolated, throw-away database: QA_ISOLATED_PG_URL must equal DATABASE_URL and point at 127.0.0.1/localhost:55432; otherwise the file is skipped.
 * Everything is synthetic. The migration tests create (and drop) their own scratch database on the same isolated server.
 *
 *   docker exec qa-pg-isolated psql -U qa -d postgres -c "CREATE DATABASE qa_iso_rev"
 *   DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_rev npx prisma db push --accept-data-loss
 *   QA_ISOLATED_PG_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_rev DATABASE_URL=postgresql://qa:qa@127.0.0.1:55432/qa_iso_rev \
 *     node --import tsx --experimental-test-module-mocks --test src/services/pg-reviews.pg.test.ts
 */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

let _db: any;
const db = async () => (_db ??= (await import('../config/db')).prisma);
const id = () => randomUUID();

async function seed(over: { projectStatus?: string; stageStatuses?: string[]; withService?: boolean } = {}) {
	const prisma = await db();
	const tag = id().slice(0, 8);
	const client = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: `Hidden${tag}`, lastName: 'Reviewer', email: `rv-client-${tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT', avatarUrl: `https://img.test/${tag}.png` } });
	await prisma.clientProfile.create({ data: { id: id(), userId: client.id, firstName: `Hidden${tag}`, lastName: 'Reviewer' } });
	const stranger = await prisma.user.create({ data: { id: id(), accountType: 'CLIENT_INDIVIDUAL', firstName: 'Stranger', lastName: 'X', email: `rv-str-${tag}@pg.test`, roles: ['CLIENT'], activeRole: 'CLIENT' } });
	const provider = await prisma.user.create({ data: { id: id(), accountType: 'PROVIDER_INDIVIDUAL', firstName: 'Prov', lastName: tag, email: `rv-prov-${tag}@pg.test`, roles: ['PROVIDER'], activeRole: 'PROVIDER' } });
	const providerProfile = await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED' } });
	let service: any = null;
	if (over.withService) {
		const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
		const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
		const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: providerProfile.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED' } });
		const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: providerProfile.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [] } });
		service = await prisma.serviceCatalog.create({ data: { id: id(), providerId: provider.id, title: `Svc ${tag}`, description: 'd', specialtyId: spec.id, accreditationSampleId: sample.id, totalAmount: 20, totalDays: 7, status: 'PUBLISHED' } });
	}
	const project = await prisma.project.create({ data: { id: id(), title: `Proj ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: over.projectStatus ?? 'COMPLETED', ...(service ? { serviceCatalogId: service.id } : {}) } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 2, status: (over.projectStatus ?? 'COMPLETED') === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE', signedAt: new Date() } });
	const statuses = over.stageStatuses ?? ['APPROVED', 'APPROVED'];
	const stages: any[] = [];
	for (let i = 0; i < statuses.length; i++) stages.push(await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: i + 1, title: `S${i + 1}`, days: 7, percentage: 100 / statuses.length, amount: 20 / statuses.length, status: statuses[i], ...(statuses[i] === 'APPROVED' ? { approvedAt: new Date() } : {}) } }));
	return { prisma, tag, client, stranger, provider, providerProfile, service, project, contract, stages };
}

const settle = async (w: Awaited<ReturnType<typeof seed>>) => w.prisma.dispute.create({ data: { id: id(), projectId: w.project.id, openedById: w.client.id, againstUserId: w.provider.id, status: 'RESOLVED', reason: 'r', description: 'd', resolution: 'SPLIT', resolvedAt: new Date() } });
const rating = async () => (await import('./rating.service')).ratingService;
const code = (e: any) => e?.statusCode;

test('pg: the isolated database is really the throw-away one', opts, async () => {
	const prisma = await db();
	const [{ current_database }] = await prisma.$queryRaw`SELECT current_database()` as any[];
	assert.equal(current_database, 'qa_iso_rev');
});

// ── duplicates + concurrency ─────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: two windows rate the same project at once -> exactly ONE review; the loser gets 409 and re-reads the saved one (both sides, 10 rounds)', opts, async () => {
	const svc = await rating();
	for (let round = 0; round < 10; round++) {
		const w = await seed();
		const c = await Promise.allSettled([svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 5, tags: ['جودة عالية'] }), svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 3 }), svc.rateRequest(w.contract.id, w.client.id, 'client', { rating: 4 })]);
		assert.equal(c.filter(r => r.status === 'fulfilled').length, 1, `round ${round}`);
		assert.ok(c.filter(r => r.status === 'rejected').every(r => code((r as any).reason) === 409));
		assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id, reviewerRole: 'CLIENT', stageId: null } }), 1);
		const st = await svc.getStatus(w.project.id, w.client.id, 'client');
		assert.equal(st.canRate, false); assert.equal(st.reason, 'ALREADY_RATED'); assert.ok(st.review);
		const p = await Promise.allSettled([svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 5 }), svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 2 })]);
		assert.equal(p.filter(r => r.status === 'fulfilled').length, 1);
		// the provider's review of the client never blocked / counted as the client's one
		assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), 2);
	}
});

test('pg: two windows rate the same STAGE at once -> exactly one stage review, the other 409', opts, async () => {
	const svc = await rating();
	for (let round = 0; round < 8; round++) {
		const w = await seed();
		const c = await Promise.allSettled([svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 5 }), svc.rateStage(w.contract.id, w.stages[0].id, w.client.id, { rating: 2 })]);
		assert.equal(c.filter(r => r.status === 'fulfilled').length, 1);
		assert.ok(c.filter(r => r.status === 'rejected').every(r => code((r as any).reason) === 409));
		assert.equal(await w.prisma.review.count({ where: { stageId: w.stages[0].id } }), 1);
		// the other stage is independent, and the project review is independent from both
		await svc.rateStage(w.project.id, w.stages[1].id, w.client.id, { rating: 4 });
		const proj = await svc.getStatus(w.project.id, w.client.id, 'client');
		assert.equal(proj.canRate, true, 'a stage review is never the project review');
	}
});

// ── ownership ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: a stranger gets 403 on status / rate / stage status / stage rate and learns nothing; a missing stage or a foreign stage is 404', opts, async () => {
	const svc = await rating(); const w = await seed(); const other = await seed();
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 5, comment: 'private-text' });
	for (const call of [
		() => svc.getStatus(w.project.id, w.stranger.id, 'client'),
		() => svc.getStatus(w.project.id, w.client.id, 'provider'), // the client calling the provider side
		() => svc.getStatus(w.project.id, w.stranger.id, 'provider'),
		() => svc.rateRequest(w.project.id, w.stranger.id, 'client', { rating: 1 }),
		() => svc.rateRequest(w.project.id, w.client.id, 'provider', { rating: 1 }),
		() => svc.getStageStatus(w.project.id, w.stages[0].id, w.stranger.id),
		() => svc.getStageStatus(w.project.id, w.stages[0].id, w.provider.id),
		() => svc.rateStage(w.project.id, w.stages[0].id, w.stranger.id, { rating: 1 })
	]) await assert.rejects(call, (e: any) => code(e) === 403);
	await assert.rejects(() => svc.getStageStatus(w.project.id, other.stages[0].id, w.client.id), (e: any) => code(e) === 404);
	await assert.rejects(() => svc.rateStage(w.project.id, other.stages[0].id, w.client.id, { rating: 1 }), (e: any) => code(e) === 404);
	await assert.rejects(() => svc.getStageStatus(id(), w.stages[0].id, w.client.id), (e: any) => code(e) === 404);
	assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), 1, 'nothing was created by the refused calls');
});

// ── stage rating flows ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: stage rating contract: not approved -> blocked (status and rate), approved -> canRate, saved -> read-only card, tags + publish stored', opts, async () => {
	const svc = await rating(); const w = await seed({ projectStatus: 'IN_PROGRESS', stageStatuses: ['APPROVED', 'SUBMITTED'] });
	const open = await svc.getStageStatus(w.project.id, w.stages[0].id, w.client.id);
	assert.deepEqual([open.scope, open.canRate, open.reason, open.review, open.adminSettled], ['STAGE', true, null, null, null]);
	const blocked = await svc.getStageStatus(w.project.id, w.stages[1].id, w.client.id);
	assert.deepEqual([blocked.canRate, blocked.reason], [false, 'STAGE_NOT_APPROVED']);
	assert.ok(blocked.message);
	await assert.rejects(() => svc.rateStage(w.project.id, w.stages[1].id, w.client.id, { rating: 5 }), (e: any) => code(e) === 400);
	await assert.rejects(() => svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 5, tags: ['توصيات واضحة'] }), (e: any) => code(e) === 400, 'a provider tag on a client review');
	const saved = await svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 4, comment: 'stage text', tags: ['جودة عالية'], publish: false });
	assert.equal(saved.isPublic, false);
	const after = await svc.getStageStatus(w.contract.id, w.stages[0].id, w.client.id);
	assert.deepEqual([after.canRate, after.reason], [false, 'ALREADY_RATED']);
	assert.deepEqual([after.review?.rating, after.review?.comment, after.review?.tags, after.review?.isPublic], [4, 'stage text', ['جودة عالية'], false]);
	await assert.rejects(() => svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 1 }), (e: any) => code(e) === 409);
	// the project-level status is not touched by the stage review, and the project is not completed -> NOT_COMPLETED
	const proj = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.deepEqual([proj.canRate, proj.reason, proj.review], [false, 'NOT_COMPLETED', null]);
});

// ── settled projects ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('pg: settled project: no new project or stage review, a review made BEFORE the settlement stays readable', opts, async () => {
	const svc = await rating(); const w = await seed();
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 4, comment: 'before settlement' });
	await svc.rateStage(w.project.id, w.stages[0].id, w.client.id, { rating: 5 });
	await settle(w);
	const st = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.equal(st.canRate, false); assert.equal(st.review?.comment, 'before settlement'); assert.ok(st.adminSettled);
	const stage0 = await svc.getStageStatus(w.project.id, w.stages[0].id, w.client.id);
	assert.equal(stage0.review?.rating, 5); assert.equal(stage0.canRate, false);
	const stage1 = await svc.getStageStatus(w.project.id, w.stages[1].id, w.client.id);
	assert.deepEqual([stage1.canRate, stage1.reason], [false, 'ADMIN_SETTLED']);
	await assert.rejects(() => svc.rateStage(w.project.id, w.stages[1].id, w.client.id, { rating: 5 }), (e: any) => code(e) === 409);
	await assert.rejects(() => svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 5 }), (e: any) => code(e) === 409);
	const providerStatus = await svc.getStatus(w.project.id, w.provider.id, 'provider');
	assert.deepEqual([providerStatus.canRate, providerStatus.reason], [false, 'ADMIN_SETTLED']);
	assert.equal(await w.prisma.review.count({ where: { projectId: w.project.id } }), 2, 'no review was added by the refused calls');
});

// ── publication: privacy through the PUBLIC readers ──────────────────────────────────────────────────────────────────────────────
test('pg: an UNPUBLISHED review never appears in the public provider profile / service page / cards, and does not enter the public average or count; the internal level gate still counts it', opts, async () => {
	const svc = await rating();
	const { providerProfileService } = await import('./provider-profile.service');
	const { MarketplaceService } = await import('./marketplace-service.service');
	const market = new MarketplaceService();
	const w = await seed({ withService: true });
	const w2 = await seed(); // a second project of the SAME provider, rated 5 and published: reuse the provider
	const p2 = await w.prisma.project.create({ data: { id: id(), title: `Proj2 ${w.tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 5, clientId: w2.client.id, providerId: w.provider.id, status: 'COMPLETED', serviceCatalogId: w.service.id } });
	await w.prisma.contract.create({ data: { id: id(), projectId: p2.id, clientId: w2.client.id, providerId: w.provider.id, price: 10, durationDays: 5, phasesCount: 1, status: 'COMPLETED', signedAt: new Date() } });
	await w.prisma.providerGamification.create({ data: { providerId: w.provider.id } }).catch(() => undefined);
	const SECRET = `SECRET-comment-${w.tag}`;
	const hidden = await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 1, comment: SECRET, tags: ['جودة عالية'], publish: false });
	const shown = await svc.rateRequest(p2.id, w2.client.id, 'client', { rating: 5, comment: 'visible text', tags: ['تواصل ممتاز'] }); // publish omitted -> public (old clients)
	assert.equal(hidden.isPublic, false); assert.equal(shown.isPublic, true);

	const pub = await providerProfileService.getPublicProfile(w.provider.id); // unauthenticated visitor: no viewer
	const json = JSON.stringify(pub);
	for (const leak of [SECRET, `Hidden${w.tag}`, w.client.id, w.client.avatarUrl, hidden.id]) assert.ok(!json.includes(leak), `public profile leaked ${leak}`);
	assert.ok(json.includes('visible text') && json.includes(`Hidden${w2.tag}`), 'the published review is shown');
	assert.equal(pub.reviews.length, 1);
	assert.equal(pub.header.stats.reviewsCount, 1, 'public count excludes the hidden review');
	assert.equal(pub.header.stats.clientRating, 100, 'public percentage = the published 5-star review only (not (1+5)/2)');
	assert.ok(!('reviewsInternal' in (pub as any)), 'visitors never get the owner-only block');
	assert.deepEqual(Object.keys(pub.reviews[0]).sort(), ['client', 'comment', 'createdAt', 'id', 'kind', 'project', 'rating', 'stageTitle', 'tags']);

	// the owner's self preview keeps the public block IDENTICAL and adds clearly separate internal numbers + the unpublished review
	const owner = await providerProfileService.getPublicProfile(w.provider.id, { isOwner: true });
	assert.equal(owner.header.stats.reviewsCount, 1); assert.equal(owner.reviews.length, 1);
	assert.deepEqual([(owner as any).reviewsInternal.count, (owner as any).reviewsInternal.average, (owner as any).reviewsInternal.unpublishedCount], [2, 3, 1]);
	assert.equal((owner as any).reviewsInternal.unpublished[0].comment, SECRET);

	// INTERNAL metrics (level gate) count every review
	const user = await w.prisma.user.findUnique({ where: { id: w.provider.id }, select: { ratingAverage: true } });
	assert.equal(user.ratingAverage, 3, 'User.ratingAverage = (1 + 5) / 2');
	const gam = await w.prisma.providerGamification.findUnique({ where: { providerId: w.provider.id } });
	if (gam) assert.equal(gam.avgRating, 3);

	// marketplace: card + detail
	const detail = await market.getMarketplaceModelById(w.service.id);
	const dj = JSON.stringify(detail);
	for (const leak of [SECRET, `Hidden${w.tag}`, w.client.id, hidden.id]) assert.ok(!dj.includes(leak), `service page leaked ${leak}`);
	assert.deepEqual([detail.reviewsCount, detail.rating, detail.reviews.length], [1, 5, 1]);
	const list = await market.getMarketplaceModels({ q: w.service.title });
	const card = list.models?.find((m: any) => m.id === w.service.id) ?? list.data?.find((m: any) => m.id === w.service.id) ?? (list as any).items?.find((m: any) => m.id === w.service.id);
	assert.ok(card, 'the service is in the public list');
	assert.deepEqual([card.reviewsCount, card.rating], [1, 5]);
	for (const sort of ['rating', 'top_rated']) {
		const sorted = await market.getMarketplaceModels({ sort });
		const arr = sorted.models ?? sorted.data ?? (sorted as any).items;
		assert.ok(arr.some((m: any) => m.id === w.service.id), `${sort} sort still lists the service`);
	}
	const minRated = await market.getMarketplaceModels({ minRating: '4' });
	assert.ok((minRated.models ?? minRated.data ?? (minRated as any).items).some((m: any) => m.id === w.service.id));

	// the hidden review is still readable by its author (status) and exists for the admin
	const own = await svc.getStatus(w.project.id, w.client.id, 'client');
	assert.deepEqual([own.review?.comment, own.review?.isPublic], [SECRET, false]);
	assert.equal(await w.prisma.review.count({ where: { id: hidden.id } }), 1);
});

test('pg: a service whose ONLY review is unpublished shows no reviews, count 0 and rating 0 publicly; an unpublished provider -> client review never reaches the client public profile', opts, async () => {
	const svc = await rating();
	const { MarketplaceService } = await import('./marketplace-service.service');
	const { clientProfileService } = await import('./client-profile.service');
	const w = await seed({ withService: true });
	await svc.rateRequest(w.project.id, w.client.id, 'client', { rating: 2, comment: 'only hidden', publish: false });
	const detail = await new MarketplaceService().getMarketplaceModelById(w.service.id);
	assert.deepEqual([detail.reviewsCount, detail.rating, detail.reviews.length], [0, 0, 0]);
	// provider -> client: hidden is invisible on the client's public profile, published is visible, the client's own status still shows both ways
	await svc.rateRequest(w.project.id, w.provider.id, 'provider', { rating: 1, comment: 'provider hidden note', publish: false });
	let prof = await clientProfileService.getPublicProfile(w.client.id);
	assert.equal(prof.stats.providerReviewsCount, 0); assert.equal(prof.stats.providerRatingAverage, null);
	assert.deepEqual(prof.reviewsFromProviders, []);
	assert.ok(!JSON.stringify(prof).includes('provider hidden note'));
	// provider->client reviews also never appear on the service page of the provider's service
	assert.equal((await new MarketplaceService().getMarketplaceModelById(w.service.id)).reviews.length, 0);
	const w2 = await seed();
	await svc.rateRequest(w2.project.id, w2.provider.id, 'provider', { rating: 4, comment: 'provider public note' });
	prof = await clientProfileService.getPublicProfile(w2.client.id);
	assert.deepEqual([prof.stats.providerReviewsCount, prof.stats.providerRatingAverage, prof.reviewsFromProviders.length], [1, 4, 1]);
});

test('pg: old reviews (inserted without a publish choice) keep isPublic = true and stay public', opts, async () => {
	const { providerProfileService } = await import('./provider-profile.service');
	const w = await seed();
	await w.prisma.review.create({ data: { id: id(), providerId: w.provider.id, clientId: w.client.id, projectId: w.project.id, reviewerRole: 'CLIENT', rating: 4, comment: 'legacy review' } });
	const row = await w.prisma.review.findFirst({ where: { projectId: w.project.id } });
	assert.equal(row.isPublic, true);
	const pub = await providerProfileService.getPublicProfile(w.provider.id);
	assert.deepEqual([pub.reviews.length, pub.header.stats.reviewsCount, pub.reviews[0].comment], [1, 1, 'legacy review']);
});

// ── migrations on a DB created from the PREVIOUS schema ────────────────────────────────────────────────────────────────────────
async function scratchDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
	const name = `qa_rev_mig_${randomUUID().slice(0, 8)}`;
	const admin = new Client({ connectionString: URL!.replace(/\/[^/]+$/, '/postgres') });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${name}`);
	const c = new Client({ connectionString: URL!.replace(/\/[^/]+$/, `/${name}`) });
	await c.connect();
	try { return await fn(c); } finally { await c.end(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
}
const sqlOf = (m: string, f: 'migration.sql' | 'rollback.sql') => readFileSync(`prisma/migrations/${m}/${f}`, 'utf8');
const TAGS = '20261017100000_review_tags'; const VIS = '20261017110000_review_visibility';
/** The reviews table exactly as it was BEFORE both migrations (no tags, no isPublic). */
const OLD_REVIEWS = `CREATE TABLE reviews (id text PRIMARY KEY, "providerId" text NOT NULL, "clientId" text, "projectId" text, "serviceId" text, "clientRequestId" text, "stageId" text, "reviewerRole" text NOT NULL DEFAULT 'CLIENT', rating double precision NOT NULL, comment text, "createdAt" timestamp(3) NOT NULL DEFAULT now())`;

test('migration: applied to a DB created from the PREVIOUS schema, old rows are byte-identical and public; applying twice is harmless', opts, async () => {
	await scratchDb(async c => {
		await c.query(OLD_REVIEWS);
		await c.query(`INSERT INTO reviews (id, "providerId", "clientId", rating, comment, "createdAt") VALUES ('r1','p','c',4,'قديم','2026-01-02 03:04:05'), ('r2','p','c2',5,NULL,'2026-02-03 04:05:06')`);
		const before = (await c.query(`SELECT id, "providerId", "clientId", rating, comment, "createdAt" FROM reviews ORDER BY id`)).rows;
		await c.query(sqlOf(TAGS, 'migration.sql'));
		await c.query(sqlOf(VIS, 'migration.sql'));
		await c.query(sqlOf(VIS, 'migration.sql'));
		const after = (await c.query(`SELECT id, "providerId", "clientId", rating, comment, "createdAt" FROM reviews ORDER BY id`)).rows;
		assert.deepEqual(after, before, 'ids, ratings, comments, dates unchanged');
		const extra = (await c.query(`SELECT "isPublic", tags FROM reviews`)).rows;
		assert.ok(extra.every(r => r.isPublic === true && r.tags.length === 0), 'every old review is public with no tags');
		const col = (await c.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='reviews' AND column_name='isPublic'`)).rows[0];
		assert.deepEqual([col.is_nullable, col.column_default], ['NO', 'true']);
	});
});

test('migration rollback: refuses with an unpublished review or saved tags (nothing dropped), succeeds on clean data', opts, async () => {
	await scratchDb(async c => {
		await c.query(OLD_REVIEWS);
		await c.query(`INSERT INTO reviews (id, "providerId", rating) VALUES ('r1','p',4)`);
		await c.query(sqlOf(TAGS, 'migration.sql')); await c.query(sqlOf(VIS, 'migration.sql'));
		const hasCol = async () => (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='reviews' AND column_name='isPublic'`)).rowCount === 1;

		await c.query(`UPDATE reviews SET "isPublic" = false WHERE id='r1'`);
		await assert.rejects(() => c.query(sqlOf(VIS, 'rollback.sql')), /ROLLBACK REFUSED: 1 review\(s\) are unpublished/);
		await c.query('ROLLBACK').catch(() => undefined);
		assert.equal(await hasCol(), true, 'the column survives');
		assert.equal((await c.query(`SELECT "isPublic" FROM reviews`)).rows[0].isPublic, false, 'the privacy decision is intact');

		await c.query(`UPDATE reviews SET "isPublic" = true, tags = ARRAY['جودة عالية']`);
		await assert.rejects(() => c.query(sqlOf(VIS, 'rollback.sql')), /ROLLBACK REFUSED: 1 review\(s\) carry tags/);
		await c.query('ROLLBACK').catch(() => undefined);
		assert.equal(await hasCol(), true);
		await assert.rejects(() => c.query(sqlOf(TAGS, 'rollback.sql')), /ROLLBACK REFUSED/);
		await c.query('ROLLBACK').catch(() => undefined);

		await c.query(`UPDATE reviews SET tags = ARRAY[]::text[]`);
		await c.query(sqlOf(VIS, 'rollback.sql'));
		assert.equal(await hasCol(), false, 'dropped only when nothing would be lost');
		const row = (await c.query(`SELECT id, rating FROM reviews`)).rows[0];
		assert.deepEqual([row.id, row.rating], ['r1', 4]);
	});
});
