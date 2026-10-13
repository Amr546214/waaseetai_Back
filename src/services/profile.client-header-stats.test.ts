import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';

// The client profile header used to read totalRequests / completedProjects / rating fields that no query ever filled (always 0 or a
// placeholder). GET /profiles/me now returns the real numbers; a failed read leaves them out instead of faking them.

function load(t: TestContext, opts: { requests?: number; completed?: number; reviews?: { count: number; avg: number | null }; fail?: boolean } = {}) {
  const user: any = { id: 'c1', status: 'ACTIVE', phoneNumber: null, firstName: 'Nora', lastName: 'Q', accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', clientProfile: { id: 'cp1', userId: 'c1', completionPercentage: 0, kycStatus: 'UNVERIFIED' } };
  const calls: any = {};
  const db: any = {
    user: { findUnique: async () => user },
    clientProfile: { update: async () => user.clientProfile },
    clientRequest: { count: async (a: any) => { calls.requests = a; if (opts.fail) throw new Error('db'); return opts.requests ?? 0; } },
    project: { count: async (a: any) => { calls.projects = a; return opts.completed ?? 0; } },
    review: { aggregate: async (a: any) => { calls.review = a; return { _count: { _all: opts.reviews?.count ?? 0 }, _avg: { rating: opts.reviews?.avg ?? null } }; } },
    profileModificationRequest: { findMany: async () => [] },
    clientOnboarding: { findUnique: async () => null },
  };
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  return import(`./profile.service.ts?fixture=${Date.now()}-${Math.random()}`).then(m => ({ svc: m.profileService, calls }));
}

test('getProfile (CLIENT) returns the real request count, completed projects and the provider-review average', async t => {
  const { svc, calls } = await load(t, { requests: 4, completed: 2, reviews: { count: 3, avg: 4.5 } });
  const me = (await svc.getProfile('c1')).currentProfileData;
  assert.equal(me.totalRequests, 4);
  assert.equal(me.completedProjects, 2);
  assert.equal(me.reviewsCount, 3);
  assert.equal(me.humanRating, 4.5);
  assert.deepEqual(calls.requests.where, { clientProfileId: 'cp1' });
  assert.deepEqual(calls.review.where, { clientId: 'c1', reviewerRole: 'PROVIDER' });
});

test('getProfile (CLIENT): no reviews = humanRating null (never 0 or a default), zero counts stay real zeros', async t => {
  const { svc } = await load(t);
  const me = (await svc.getProfile('c1')).currentProfileData;
  assert.equal(me.humanRating, null);
  assert.equal(me.reviewsCount, 0);
  assert.equal(me.totalRequests, 0);
});

test('getProfile (CLIENT): a failing stats read never breaks the profile and fakes nothing', async t => {
  const { svc } = await load(t, { fail: true });
  const me = (await svc.getProfile('c1')).currentProfileData;
  assert.equal('totalRequests' in me, false);
  assert.equal('humanRating' in me, false);
});

test('language / timezone: unsupported language and an over-long timezone are rejected, supported values pass', () => {
  assert.equal(updateProfileSchema.safeParse({ interfaceLanguage: 'Klingon' }).success, false);
  assert.equal(updateProfileSchema.safeParse({ timezone: 'x'.repeat(61) }).success, false);
  assert.equal(updateProfileSchema.safeParse({ interfaceLanguage: 'English', timezone: '(GMT+3) توقيت الرياض' }).success, true);
});
