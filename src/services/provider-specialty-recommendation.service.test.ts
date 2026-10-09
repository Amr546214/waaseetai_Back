import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSpecialtyRecommendation, type RecommendationDb } from './provider-specialty-recommendation.service';

// Rule-based recommendation: every case below is a fake in-memory catalog + provider data (no database).
const CATS = { web: { id: 'c-web', name: 'البرمجة والتقنية' }, design: { id: 'c-des', name: 'التصميم' }, writing: { id: 'c-wri', name: 'الكتابة' } };
const SPECS = [
  { id: 's-front', nameAr: 'تطوير الواجهات الأمامية', nameEn: 'Frontend', categoryId: CATS.web.id, category: { nameAr: CATS.web.name } },
  { id: 's-back', nameAr: 'تطوير الواجهات الخلفية', nameEn: null, categoryId: CATS.web.id, category: { nameAr: CATS.web.name } },
  { id: 's-ui', nameAr: 'تصميم واجهات المستخدم', nameEn: null, categoryId: CATS.design.id, category: { nameAr: CATS.design.name } },
  { id: 's-copy', nameAr: 'كتابة المحتوى', nameEn: null, categoryId: CATS.writing.id, category: { nameAr: CATS.writing.name } },
];

function fakeDb(o: { profile?: any; proposals?: string[]; open?: Record<string, number>; specs?: any[] } = {}): RecommendationDb {
  const specs = o.specs ?? SPECS;
  return {
    providerProfile: { findUnique: async () => o.profile === undefined ? { id: 'pp', mainSpecialty: null, subSpecialties: [], providerSpecialties: [] } : o.profile },
    proposal: { findMany: async () => (o.proposals ?? []).map(id => ({ clientRequest: { specialtyId: id } })) },
    specialty: { findMany: async () => specs },
    clientRequest: { groupBy: async () => Object.entries(o.open ?? {}).map(([specialtyId, n]) => ({ specialtyId, _count: { _all: n } })) },
  };
}

test('provider with proposal history -> history recommendation whose reason names the real count and category', async () => {
  const r = await computeSpecialtyRecommendation(fakeDb({ proposals: ['s-ui', 's-ui', 's-ui', 's-front'] }), 'u1');
  assert.equal(r.hasRecommendation, true);
  assert.equal(r.source, 'provider_history');
  assert.equal(r.reason, 'PROPOSAL_HISTORY');
  assert.equal(r.categoryId, CATS.design.id);
  assert.deepEqual(r.specialtyIds, ['s-ui']);
  assert.match(r.message, /3 عروض/);
  assert.match(r.message, /التصميم/);
});

test('history never suggests a specialty the provider already registered, and picks the next best', async () => {
  const profile = { id: 'pp', mainSpecialty: null, subSpecialties: [], providerSpecialties: [{ specialtyId: 's-ui', specialty: { categoryId: CATS.design.id } }] };
  const r = await computeSpecialtyRecommendation(fakeDb({ profile, proposals: ['s-ui', 's-ui', 's-front'] }), 'u1');
  assert.equal(r.source, 'provider_history');
  assert.deepEqual(r.specialtyIds, ['s-front']);
  assert.match(r.message, /عرضًا واحدًا/);
});

test('no history but the profile names a specialty -> profile recommendation; the message never mentions previous requests', async () => {
  const profile = { id: 'pp', mainSpecialty: 'كتابة المحتوى', subSpecialties: [], providerSpecialties: [] };
  const r = await computeSpecialtyRecommendation(fakeDb({ profile }), 'u1');
  assert.equal(r.source, 'profile');
  assert.equal(r.reason, 'PROFILE_MATCH');
  assert.deepEqual(r.specialtyIds, ['s-copy']);
  assert.doesNotMatch(r.message, /طلبات|عروض|سابق/);
  assert.match(r.message, /ملفك/);
});

test('profile naming only a category recommends the category with no specialties', async () => {
  const profile = { id: 'pp', mainSpecialty: 'التصميم', subSpecialties: [], providerSpecialties: [] };
  const r = await computeSpecialtyRecommendation(fakeDb({ profile }), 'u1');
  assert.equal(r.source, 'profile');
  assert.equal(r.categoryId, CATS.design.id);
  assert.deepEqual(r.specialtyIds, []);
});

test('no history and no profile data -> the most requested category by open requests, honestly worded (no "previous requests")', async () => {
  const r = await computeSpecialtyRecommendation(fakeDb({ open: { 's-front': 5, 's-back': 3, 's-ui': 2 } }), 'u1');
  assert.equal(r.source, 'popular');
  assert.equal(r.reason, 'OPEN_DEMAND');
  assert.equal(r.categoryId, CATS.web.id);
  assert.deepEqual(r.specialtyIds, ['s-front', 's-back']);
  assert.match(r.message, /8 طلبات/);
  assert.doesNotMatch(r.message, /سابق|طلباتك/);
});

test('popular skips a category where the provider already has a specialty', async () => {
  const profile = { id: 'pp', mainSpecialty: null, subSpecialties: [], providerSpecialties: [{ specialtyId: 's-front', specialty: { categoryId: CATS.web.id } }] };
  const r = await computeSpecialtyRecommendation(fakeDb({ profile, open: { 's-front': 5, 's-ui': 2 } }), 'u1');
  assert.equal(r.source, 'popular');
  assert.equal(r.categoryId, CATS.design.id);
});

test('no data at all -> hasRecommendation=false with an empty, text-free result', async () => {
  const r = await computeSpecialtyRecommendation(fakeDb(), 'u1');
  assert.deepEqual(r, { hasRecommendation: false, source: 'none', reason: 'NO_DATA', message: '', categoryId: null, categoryName: null, specialtyIds: [], specialtyNames: [] });
});

test('a provider without a profile gets the empty result', async () => {
  const r = await computeSpecialtyRecommendation(fakeDb({ profile: null }), 'u1');
  assert.equal(r.hasRecommendation, false);
});

test('only specialties present in the (active-only) catalog can be suggested: unknown / inactive ids from history or demand are ignored', async () => {
  // The catalog query already filters isActive; ids that are not in it (inactive/deleted) must never surface.
  const r = await computeSpecialtyRecommendation(fakeDb({ proposals: ['s-inactive', 's-gone'], open: { 's-inactive': 9 } }), 'u1');
  assert.equal(r.hasRecommendation, false);
});

test('the catalog query asks for active specialties of active categories only', async () => {
  let captured: any;
  const db = fakeDb({ open: { 's-front': 1 } });
  const orig = db.specialty.findMany;
  db.specialty.findMany = async (args: any) => { captured = args; return orig(args); };
  await computeSpecialtyRecommendation(db, 'u1');
  assert.deepEqual(captured.where, { isActive: true, category: { isActive: true } });
});

test('the route is provider-only and registered before the /:id routes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../routes/provider-specialty.routes.ts', import.meta.url), 'utf8');
  const i = src.indexOf("router.get('/recommendations'");
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 80), /\.\.\.providerAuth/);
  assert.ok(i < src.indexOf("router.get('/:id/status'"));
  assert.ok(i < src.indexOf("router.post('/:id/ai-evaluate'"));
});
