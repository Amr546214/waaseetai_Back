import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

// Provider setup GET: a rejected identity review is returned with the admin's reason on its own field (the admin stores it as "سبب الرفض: …"),
// and nothing else changes for the other statuses.
const mockRes = () => { const r: any = { statusCode: 200, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };
let profile: any = null;
async function load(t: TestContext) {
  t.mock.module('../config/db', { namedExports: { prisma: { providerProfile: { findUnique: async () => profile } } } });
  t.mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
  t.mock.module('../services/session.service', { namedExports: { sessionService: {} } });
  t.mock.module('../services/provider-profile.service', { namedExports: { providerProfileService: {} } });
  return import(`./provider-profile.controller.ts?f=${Date.now()}-${Math.random()}`);
}
const get = async (t: TestContext) => { const { getSetupData } = await load(t); const res = mockRes(); await getSetupData({ user: { id: 'u1' } } as any, res); return res.body.data; };

test('REJECTED: the reason is returned without the "سبب الرفض:" prefix', async (t) => {
  profile = { id: 'p1', kycStatus: 'REJECTED', notes: 'سبب الرفض: الصورة غير واضحة', skills: [], portfolioItems: [] };
  const d = await get(t);
  assert.deepEqual([d.kycStatus, d.kycRejectionReason], ['REJECTED', 'الصورة غير واضحة']);
});
for (const kycStatus of ['PENDING', 'VERIFIED', 'UNVERIFIED']) {
  test(`${kycStatus}: no reason, even if an old note is there`, async (t) => {
    profile = { id: 'p1', kycStatus, notes: 'سبب الرفض: قديم', skills: [], portfolioItems: [] };
    assert.equal((await get(t)).kycRejectionReason, null);
  });
}
test('REJECTED with a note that is not a rejection reason: the generic message, never the raw note', async (t) => {
  profile = { id: 'p1', kycStatus: 'REJECTED', notes: 'ملاحظة داخلية سرية', skills: [], portfolioItems: [] };
  const d = await get(t);
  assert.equal(d.kycRejectionReason, 'تم رفض المستندات. يرجى رفع مستندات أوضح أو التواصل مع الدعم.');
  assert.doesNotMatch(JSON.stringify(d), /ملاحظة داخلية سرية/);
});

for (const [kycStatus, notes] of [['REJECTED', 'سبب الرفض: الصورة غير واضحة'], ['REJECTED', 'ملاحظة داخلية سرية'], ['PENDING', 'internal'], ['VERIFIED', 'internal'], ['UNVERIFIED', null]] as const) {
  test(`the raw "notes" column is never in the response (${kycStatus}, ${notes ?? 'no note'})`, async (t) => {
    profile = { id: 'p1', kycStatus, notes, skills: [], portfolioItems: [] };
    const d = await get(t);
    assert.equal('notes' in d, false);
    if (notes) assert.equal(JSON.stringify(d).includes(notes.replace('سبب الرفض: ', '')) && kycStatus !== 'REJECTED', false);
  });
}

test('a profile with no note and no review still answers normally (pending / approved are not affected)', async (t) => {
  profile = { id: 'p1', kycStatus: 'PENDING', notes: null, headline: 'مصمم', skills: [], portfolioItems: [] };
  const d = await get(t);
  assert.deepEqual([d.kycStatus, d.headline, d.kycRejectionReason], ['PENDING', 'مصمم', null]);
});
