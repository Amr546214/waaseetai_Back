import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function loadReview(t: TestContext, workSamples: any[]) {
  const ps = { id: 'ps1', status: 'UNDER_AI_REVIEW', subSpecialties: [], specialty: { id: 's', nameAr: 'تصميم', category: { nameAr: 'ت' } }, providerProfileId: 'pp1', providerProfile: { userId: 'u1', user: {} }, accreditationSamples: [], workSamples, createdAt: new Date(), updatedAt: new Date() };
  const prisma = { providerSpecialty: { findUnique: async () => ps, findMany: async () => [] }, accountAuditLog: { findMany: async () => [] } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  return (await import(`./specialty-admin-review.service.ts?f=${Date.now()}-${Math.random()}`)).specialtyReviewQueryService;
}

test('admin specialty detail: a link proof carries its https address, a file proof carries NO stored reference', async (t) => {
  const svc = await loadReview(t, [{ id: 'w1', title: 'متجر', proofs: [
    { id: 'p1', fileName: 'github.com/acme/shop', fileUrl: 'https://github.com/acme/shop', mimeType: 'text/uri-list', fileBytes: 0 },
    { id: 'p2', fileName: 'invoice.pdf', fileUrl: 'priv:secret-ref-123', mimeType: 'application/pdf', fileBytes: 1200 },
    { id: 'p3', fileName: 'bad', fileUrl: 'javascript:alert(1)', mimeType: 'text/uri-list', fileBytes: 0 },
  ] }]);
  const out = await svc.get('ps1');
  const proofs = out.workSamples[0].proofs;
  assert.deepEqual(proofs.map((p: any) => [p.id, p.kind, p.url]), [['p1', 'LINK', 'https://github.com/acme/shop'], ['p2', 'FILE', null], ['p3', 'FILE', null]]);
  assert.equal(JSON.stringify(out).includes('secret-ref-123'), false);
  assert.equal(JSON.stringify(out).includes('javascript:'), false);
});

async function loadAccess(t: TestContext, row: any) {
  const logs: any[] = [];
  const prisma = { proofAttachment: { findUnique: async () => row } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async (a: any) => { logs.push(a); } } } });
  const m = await import(`./kyc-document-access.service.ts?f=${Date.now()}-${Math.random()}`);
  return { m, logs };
}
const rowOf = (fileUrl: string, mimeType: string) => ({ fileUrl, mimeType, workSample: { providerSpecialty: { providerProfile: { userId: 'owner1' } } } });
const admin = { id: 'a1', accountType: 'ADMIN' as any };

test('access route: an admin opens a LINK proof as it is (audited); a non-https or non-link value is still refused', async (t) => {
  const ok = await loadAccess(t, rowOf('https://github.com/acme/shop', 'text/uri-list'));
  const link = await ok.m.createKycAccessLink(admin, { document: 'specialty_proof', id: 'p1' });
  assert.equal(link.url, 'https://github.com/acme/shop'); assert.equal(link.private, false);
  assert.equal(ok.logs.length, 1);
});
test('access route: an external https value on a FILE proof (not a link) is refused', async (t) => {
  const { m } = await loadAccess(t, rowOf('https://evil.example.com/x.pdf', 'application/pdf'));
  await assert.rejects(() => m.createKycAccessLink(admin, { document: 'specialty_proof', id: 'p1' }), (e: any) => e.statusCode === 404);
});
test('access route: a link proof with a non-https address is refused', async (t) => {
  const { m } = await loadAccess(t, rowOf('http://github.com/x', 'text/uri-list'));
  await assert.rejects(() => m.createKycAccessLink(admin, { document: 'specialty_proof', id: 'p1' }), (e: any) => e.statusCode === 404);
});
