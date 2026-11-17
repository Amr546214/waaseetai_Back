import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityClaimService, identityClaimDigest, normalizeIdentityNumber, identityUniqueEnforced, IDENTITY_ALREADY_REGISTERED_CODE } from './identity-claim.service';

type Claim = { digest: string; userId: string; party: string };
function fakeDb(profiles: { client?: any; provider?: any } = {}, opts: { raceOwner?: string } = {}) {
  const claims: Claim[] = [];
  const db: any = {
    claims,
    identityClaim: {
      findUnique: async ({ where }: any) => claims.find(c => c.digest === where.digest) ?? null,
      findMany: async ({ where }: any) => claims.filter(c => c.userId === where.userId),
      create: async ({ data }: any) => {
        if (opts.raceOwner && !claims.find(c => c.digest === data.digest)) { claims.push({ digest: data.digest, userId: opts.raceOwner, party: 'CLIENT' }); throw Object.assign(new Error('unique'), { code: 'P2002' }); }
        if (claims.find(c => c.digest === data.digest)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        claims.push(data);
      },
      deleteMany: async ({ where }: any) => { for (const d of where.digest.in) { const i = claims.findIndex(c => c.userId === where.userId && c.digest === d); if (i >= 0) claims.splice(i, 1); } },
    },
    clientProfile: { findUnique: async () => profiles.client ?? null },
    providerProfile: { findUnique: async () => profiles.provider ?? null },
  };
  return db;
}
const on = () => new IdentityClaimService(() => true);
const ID = { idNumber: '1234567890', idIssuingCountry: 'SA' };

test('the number is normalised (digits in any script, spaces, dashes, case) and the digest depends on country + number only', () => {
  assert.equal(normalizeIdentityNumber('١٢٣ ٤٥٦-٧٨٩٠'), '1234567890');
  assert.equal(normalizeIdentityNumber(' ab-12 c3 '), 'AB12C3');
  const base = identityClaimDigest(ID)!;
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(identityClaimDigest({ idNumber: '123 456 7890', idIssuingCountry: 'sa' }), base);
  assert.equal(identityClaimDigest({ idNumber: '١٢٣٤٥٦٧٨٩٠', idIssuingCountry: 'SA' }), base);
  assert.notEqual(identityClaimDigest({ ...ID, idIssuingCountry: 'EG' }), base);
  assert.notEqual(identityClaimDigest({ ...ID, idNumber: '1234567891' }), base);
  assert.equal(identityClaimDigest({ idNumber: '12', idIssuingCountry: 'SA' }), null);
  assert.equal(identityClaimDigest({}), null);
});

test('the flag: off by default, on only with IDENTITY_UNIQUE_ENFORCEMENT=on; off means the database is never touched', async () => {
  assert.equal(identityUniqueEnforced({}), false);
  assert.equal(identityUniqueEnforced({ IDENTITY_UNIQUE_ENFORCEMENT: 'off' }), false);
  assert.equal(identityUniqueEnforced({ IDENTITY_UNIQUE_ENFORCEMENT: ' ON ' }), true);
  const boom: any = new Proxy({}, { get() { throw new Error('database touched'); } });
  const off = new IdentityClaimService(() => false);
  await off.assertAvailable(boom, 'u1', ID); await off.claim(boom, 'u1', 'CLIENT', ID); await off.release(boom, 'u1', 'CLIENT');
});

test('a second account with the same approved identity is refused at the identity step, without revealing the first account; the first account and unrelated numbers pass', async () => {
  const db = fakeDb(); const svc = on();
  await svc.claim(db, 'first', 'CLIENT', ID);
  await assert.rejects(() => svc.assertAvailable(db, 'second', { idNumber: '١٢٣٤٥٦٧٨٩٠', idIssuingCountry: 'sa' }), (e: any) => {
    assert.equal(e.statusCode, 409); assert.equal(e.code, IDENTITY_ALREADY_REGISTERED_CODE);
    assert.ok(!JSON.stringify(e.errors ?? e).includes('first'), 'no account id leaks to the other user');
    return true;
  });
  await svc.assertAvailable(db, 'first', ID);
  await svc.assertAvailable(db, 'second', { idNumber: '9999999999', idIssuingCountry: 'SA' });
  await svc.assertAvailable(db, 'second', { idNumber: '', idIssuingCountry: 'SA' });
});

test('the approval takes the claim; another holder refuses the approval (the administrator is told who holds it); the same account is a no-op', async () => {
  const db = fakeDb(); const svc = on();
  await svc.claim(db, 'a', 'CLIENT', ID);
  await svc.claim(db, 'a', 'PROVIDER', ID);
  assert.equal(db.claims.length, 1);
  await assert.rejects(() => svc.claim(db, 'b', 'PROVIDER', ID), (e: any) => e.code === IDENTITY_ALREADY_REGISTERED_CODE && JSON.stringify(e.errors).includes('"claimedByUserId":"a"'));
  assert.equal(db.claims.length, 1);
});

test('two approvals racing for one identity: the loser is refused whichever order the database decides', async () => {
  const lostToOther = fakeDb({}, { raceOwner: 'winner' });
  await assert.rejects(() => on().claim(lostToOther, 'loser', 'CLIENT', ID), (e: any) => e.code === IDENTITY_ALREADY_REGISTERED_CODE);
  const lostToSelf = fakeDb({}, { raceOwner: 'me' });
  await on().claim(lostToSelf, 'me', 'CLIENT', ID);
});

test('releasing: a rejected or cancelled approval frees the number; an account that still holds an approved identity with it on its other profile keeps it', async () => {
  const db = fakeDb(); const svc = on();
  await svc.claim(db, 'a', 'CLIENT', ID);
  await svc.release(db, 'a', 'CLIENT');
  assert.equal(db.claims.length, 0);
  await svc.assertAvailable(db, 'b', ID); // free again
  const both = fakeDb({ provider: { kycStatus: 'VERIFIED', ...ID } });
  await svc.claim(both, 'a', 'CLIENT', ID);
  await svc.release(both, 'a', 'CLIENT');
  assert.equal(both.claims.length, 1, 'the provider profile is still approved with the same number');
  const notVerified = fakeDb({ provider: { kycStatus: 'PENDING', ...ID } });
  await svc.claim(notVerified, 'a', 'CLIENT', ID);
  await svc.release(notVerified, 'a', 'CLIENT');
  assert.equal(notVerified.claims.length, 0);
});
