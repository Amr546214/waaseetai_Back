import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeClientSpecialtyRecommendation, type ClientRecommendationDb } from './client-specialty-recommendation.service';

// Fake in-memory catalog (shaped like the real dev catalog) + fake client data: no database.
const mk = (id: string, nameAr: string, categoryId: string, category: any, extra: any = {}) => ({ id, nameAr, nameEn: null, slug: id, description: null, categoryId, category, ...extra });
const DEV = { nameAr: 'برمجة وتطوير', nameEn: 'Programming & Development', slug: 'programming', description: 'خدمات تطوير البرمجيات وتطبيقات الويب والجوال والأنظمة الخلفية.' };
const DES = { nameAr: 'تصميم وإبداع', nameEn: 'Design', slug: 'design', description: 'تصميم الهويات والواجهات.' };
const WRI = { nameAr: 'كتابة وترجمة', nameEn: 'Writing', slug: 'writing', description: 'كتابة المحتوى والترجمة.' };
const SPECS = [
  mk('s-fe', 'تطوير الواجهات الأمامية', 'c-dev', DEV), mk('s-ios', 'تطوير تطبيقات iOS', 'c-dev', DEV), mk('s-and', 'تطوير تطبيقات أندرويد', 'c-dev', DEV),
  mk('s-site', 'تصميم المواقع', 'c-des', DES), mk('s-logo', 'شعارات وهوية بصرية', 'c-des', DES),
  mk('s-copy', 'كتابة المحتوى', 'c-wri', WRI), mk('s-tr', 'الترجمة', 'c-wri', WRI),
];

function fakeDb(o: { mine?: string[]; open?: Record<string, number>; specs?: any[] } = {}): ClientRecommendationDb & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    specialty: { findMany: async (a: any) => { calls.push(a); return o.specs ?? SPECS; } },
    clientRequest: {
      findMany: async () => (o.mine ?? []).map(specialtyId => ({ specialtyId })),
      groupBy: async () => Object.entries(o.open ?? {}).map(([specialtyId, n]) => ({ specialtyId, _count: { _all: n } })),
    },
  };
}

test('text_match: "برمجة موقع" suggests programming & development', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb(), 'u1', 'برمجة موقع');
  assert.equal(r.hasRecommendation, true);
  assert.equal(r.source, 'text_match');
  assert.equal(r.categoryId, 'c-dev');
  assert.equal(r.reason, 'TEXT_MATCH');
  assert.ok(r.confidence! > 0 && r.confidence! <= 1);
  assert.match(r.message, /برمجة وتطوير/);
  assert.doesNotMatch(r.message, /سابق|AI|ذكاء/);
});

test('text_match: "تطبيق" lands on the programming category and picks the app specialties', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb(), 'u1', 'عايز تطبيق');
  assert.equal(r.source, 'text_match');
  assert.equal(r.categoryId, 'c-dev');
  assert.deepEqual([...r.specialtyIds].sort(), ['s-and', 's-ios']);
});

test('text_match: a design/writing text goes to its own category', async () => {
  assert.equal((await computeClientSpecialtyRecommendation(fakeDb(), 'u1', 'تصميم شعار لشركتي')).categoryId, 'c-des');
  assert.equal((await computeClientSpecialtyRecommendation(fakeDb(), 'u1', 'ترجمة مستند')).categoryId, 'c-wri');
});

test('text_match: stop words alone or unrelated text fall through (no false match)', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb(), 'u1', 'اريد خدمة من فضلك');
  assert.notEqual(r.source, 'text_match');
});

test('client_history only appears when the client really has earlier requests, and says so', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb({ mine: ['s-logo', 's-logo', 's-site'], open: { 's-fe': 9 } }), 'u1');
  assert.equal(r.source, 'client_history');
  assert.equal(r.reason, 'CLIENT_HISTORY');
  assert.equal(r.categoryId, 'c-des');
  assert.deepEqual(r.specialtyIds, ['s-logo', 's-site']);
  assert.match(r.message, /3 طلبات سابقة/);
  assert.equal(r.confidence, null);
});

test('without history the same input never claims "previous requests"', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb({ open: { 's-fe': 4 } }), 'u1');
  assert.notEqual(r.source, 'client_history');
  assert.doesNotMatch(r.message, /سابق/);
});

test('popular: honest wording ("الأكثر طلبًا على المنصة"), no "previous requests"', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb({ open: { 's-fe': 5, 's-ios': 2, 's-site': 3 } }), 'u1');
  assert.equal(r.source, 'popular');
  assert.equal(r.reason, 'OPEN_DEMAND');
  assert.equal(r.categoryId, 'c-dev');
  assert.deepEqual(r.specialtyIds, ['s-fe', 's-ios']);
  assert.match(r.message, /الأكثر طلبًا على المنصة/);
  assert.match(r.message, /7 طلبات مفتوحة/);
  assert.doesNotMatch(r.message, /سابق|طلباتك|AI|ذكاء/);
});

test('none: no text, no history, no open demand', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb(), 'u1');
  assert.deepEqual(r, { hasRecommendation: false, source: 'none', reason: 'NO_DATA', message: '', categoryId: null, categoryName: null, specialtyIds: [], specialtyNames: [], confidence: null });
});

test('only specialties of the (active-only) catalog are ever suggested: unknown ids from history or demand are ignored', async () => {
  const r = await computeClientSpecialtyRecommendation(fakeDb({ mine: ['s-gone'], open: { 's-inactive': 9 } }), 'u1');
  assert.equal(r.hasRecommendation, false);
});

test('the catalog is queried for active specialties of active categories only; a text is capped', async () => {
  const db = fakeDb();
  await computeClientSpecialtyRecommendation(db, 'u1', 'برمجة ' + 'x'.repeat(2000));
  assert.deepEqual(db.calls[0].where, { isActive: true, category: { isActive: true } });
});

test('route: client-only, registered before the :id routes, compute-only (no write calls in the service)', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(new URL('../routes/client-requests.routes.ts', import.meta.url), 'utf8');
  const i = routes.indexOf("'/specialty-recommendations'");
  assert.ok(i > 0);
  assert.match(routes.slice(i, i + 300), /authorize\(AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\)/);
  assert.ok(i < routes.indexOf("router.get('/:id/workspace'"));
  const svc = readFileSync(new URL('./client-specialty-recommendation.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
});
