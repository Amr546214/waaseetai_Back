import { test } from 'node:test';
import assert from 'node:assert/strict';

const APPROVED = { idNumber: '1051245098', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob: new Date('2004-08-01'), frontIdUrl: 'private:front', backIdUrl: null, kycStatus: 'VERIFIED', identityApprovedDigest: 'd1', country: 'مصر', city: 'القاهرة' };

function fakeDb(client: any, provider: any) {
  const updates: any[] = []; const onboarding: any[] = [];
  const tx: any = {
    $queryRaw: async () => [],
    clientProfile: { findUnique: async () => client, update: async (a: any) => { updates.push(['client', a.data]); } },
    providerProfile: { findUnique: async () => provider, update: async (a: any) => { updates.push(['provider', a.data]); } },
    clientOnboarding: { updateMany: async (a: any) => { onboarding.push(a); } },
  };
  return { db: { ...tx, $transaction: async (fn: any) => fn(tx) }, updates, onboarding };
}
const load = async (t: any, db: any) => {
  t.mock.module('../config/db', { namedExports: { prisma: db } });
  t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
  return (await import(`./identity-gate.service.ts?fixture=${Date.now()}${Math.random()}`)).identityGateService;
};

test('a provider role with a waiting review adopts the approved client identity of the same account (same number): no second upload, no second review', async t => {
  const f = fakeDb(APPROVED, { idNumber: '1051245098', idIssuingCountry: 'EG', kycStatus: 'PENDING', frontIdUrl: 'private:new', identityApprovedDigest: null });
  const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'PROVIDER'), true);
  const [role, data] = f.updates[0]; assert.equal(role, 'provider');
  assert.equal(data.kycStatus, 'VERIFIED'); assert.equal(data.identityApprovedDigest, 'd1'); assert.equal(data.isVerified, true); assert.equal(data.frontIdUrl, 'private:front');
});
test('a provider role with no number of its own adopts too', async t => {
  const f = fakeDb(APPROVED, { idNumber: null, kycStatus: 'UNVERIFIED' }); const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'PROVIDER'), true);
});
test('a DIFFERENT number is a different document: left to the administration, nothing is changed', async t => {
  const f = fakeDb(APPROVED, { idNumber: '29999999999999', kycStatus: 'PENDING', frontIdUrl: 'x' }); const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'PROVIDER'), false); assert.equal(f.updates.length, 0);
});
test('nothing is adopted from an unapproved other role', async t => {
  const f = fakeDb({ ...APPROVED, kycStatus: 'PENDING' }, { idNumber: null, kycStatus: 'UNVERIFIED' }); const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'PROVIDER'), false); assert.equal(f.updates.length, 0);
});
test('an already approved role is left alone', async t => {
  const f = fakeDb(APPROVED, { ...APPROVED }); const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'PROVIDER'), false); assert.equal(f.updates.length, 0);
});
test('a client role adopts an approved provider identity and closes its waiting onboarding review', async t => {
  const f = fakeDb({ idNumber: null, kycStatus: 'PENDING', frontIdUrl: 'x' }, APPROVED); const svc = await load(t, f.db);
  assert.equal(await svc.adoptApprovedIdentity('u', 'CLIENT'), true);
  assert.equal(f.updates[0][0], 'client'); assert.equal(f.updates[0][1].kycStatus, 'VERIFIED'); assert.equal('isVerified' in f.updates[0][1], false);
  assert.equal(f.onboarding[0].data.status, 'APPROVED');
});
