import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRatingSchema } from '../dtos/rating.dto';
import { publicAverage, publicProviderReviewsWhere, publicClientReviewsWhere, publicServiceReviewsWhere } from './review-visibility';

const read = (p: string) => readFileSync(p, 'utf8');

test('DTO: publish is an optional boolean (omitted = public for old clients); a non-boolean is refused', () => {
	assert.equal(createRatingSchema.parse({ rating: 5 }).publish, undefined);
	assert.equal(createRatingSchema.parse({ rating: 5, publish: false }).publish, false);
	assert.equal(createRatingSchema.safeParse({ rating: 5, publish: 'no' }).success, false);
});

test('visibility filters: every public where-clause demands isPublic = true and the right reviewer role', () => {
	assert.deepEqual(publicProviderReviewsWhere('p'), { providerId: 'p', reviewerRole: 'CLIENT', isPublic: true });
	assert.deepEqual(publicClientReviewsWhere('c'), { clientId: 'c', reviewerRole: 'PROVIDER', isPublic: true });
	assert.deepEqual(publicServiceReviewsWhere('s'), { serviceId: 's', reviewerRole: 'CLIENT', isPublic: true });
	assert.equal(publicAverage([]), null);
	assert.equal(publicAverage([{ rating: 5 }, { rating: 4 }]), 4.5);
});

test('static: every PUBLIC review reader goes through the visibility filters', () => {
	const provider = read('src/services/provider-profile.service.ts');
	assert.match(provider, /publicProviderReviewsWhere\(providerId\)/);
	assert.match(provider, /const reviewsCount = publicAgg\._count\._all;/, 'the public count comes from the published-only aggregate');
	assert.ok(!/gamification\?\.avgRating \|\| profile\.user\?\.ratingAverage/.test(provider), 'the public percentage never reads the internal average');
	assert.match(read('src/services/client-profile.service.ts'), /publicClientReviewsWhere\(userId\)/);
	const market = read('src/services/marketplace-service.service.ts');
	assert.match(market, /publicServiceReviewsWhere\(s\.id\)/);
	assert.match(market, /PUBLIC_SERVICE_REVIEWS_RELATION/);
	assert.match(market, /reviewerRole: 'CLIENT', isPublic: true \}/);
	assert.match(read('src/services/marketplace-ai.service.ts'), /reviews: \{ where: \{ reviewerRole: 'CLIENT', isPublic: true \}/);
});

test('static: the INTERNAL level gate keeps counting every review (documented, not filtered by isPublic)', () => {
	const rating = read('src/services/rating.service.ts');
	const fn = rating.slice(rating.indexOf('async function refreshProviderAggregates'), rating.indexOf('export type RatingTarget'));
	assert.match(fn, /review\.aggregate\(\{ where: \{ providerId, reviewerRole: 'CLIENT' \}/);
	assert.ok(!fn.includes('isPublic'), 'the level gate must not depend on publication');
	assert.match(rating, /INTERNAL aggregate \(NOT the public one\)/);
	const progress = read('src/services/project-progress.service.ts');
	assert.match(progress, /tx\.review\.aggregate\(\{ where: \{ providerId: contract\.providerId, reviewerRole: 'CLIENT' \}/);
	assert.ok(!/gamification[\s\S]*isPublic/.test(read('src/services/gamification.service.ts')), 'gamification counts all reviews');
});

test('static: the stage rating status route exists next to the stage rating route, client only', () => {
	const routes = read('src/routes/client-requests.routes.ts');
	assert.match(routes, /router\.get\('\/:id\/stages\/:stageId\/rating-status', authenticate, requireActiveUser, clientOnly, stageRatingStatusAsClient\)/);
	assert.match(routes, /router\.post\('\/:id\/stages\/:stageId\/rating'/);
});

test('migration files exist with a self-protecting rollback and no data rewrite', () => {
	const dir = 'prisma/migrations/20261017110000_review_visibility';
	const up = read(`${dir}/migration.sql`);
	assert.match(up, /ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT true/);
	assert.ok(!/UPDATE|DELETE|DROP/i.test(up.replace(/--.*$/gm, '')), 'the migration only adds the column');
	const down = read(`${dir}/rollback.sql`);
	assert.match(down, /ROLLBACK REFUSED/);
	assert.match(down, /"isPublic" = false/);
	assert.match(down, /cardinality\("tags"\) > 0/);
});

test('provider notification route helper points at the provider rating page', async () => {
	const { PROVIDER_ROUTES } = await import('./provider-notifications.service');
	assert.equal(PROVIDER_ROUTES.rating('abc'), '/provider-overview/projects/abc/rating');
	const { clientNotificationFor } = await import('./client-notifications.service');
	const n = clientNotificationFor.projectCompleted({ clientId: 'c', projectId: 'abc' });
	assert.equal(n.actionUrl, '/client-overview/projects/abc/rating');
});
