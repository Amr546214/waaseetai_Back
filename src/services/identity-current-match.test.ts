import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IdentityFieldCheckService } from './identity-field-check.service';
import { legalNameKey } from '../utils/legal-name';

process.env.JWT_SECRET ??= 'test-secret';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fields = () => ({ fullName: { status: 'MATCH' }, birthDate: { status: 'MATCH' }, nationalId: { status: 'MATCH' } });
function fixture(party: 'CLIENT' | 'PROVIDER' = 'CLIENT') {
 const user = { legalName: 'عمرو محمود' };
 const profile = { idNumber: '29001011234567', idIssuingCountry: 'EG', idDocumentType: 'NATIONAL_ID', dob: new Date('1990-01-01'), frontIdUrl: 'private:image:jpg:waseetai/clients/u/identity/front-id-a' };
 const check = { id: 'latest', status: 'DONE', imageRefDigest: sha(profile.frontIdUrl), dataDigest: sha(JSON.stringify({ n: legalNameKey(user.legalName), b: '1990-01-01', i: profile.idNumber, d: { country: 'EG', type: 'NATIONAL_ID' } })), fieldResults: fields() };
 let enabled = true; let reads = 0;
 const db: any = { user: { findUnique: async ({ where }: any) => { assert.equal(where.id, 'u'); reads++; return user; } }, clientProfile: { findUnique: async () => profile }, providerProfile: { findUnique: async () => profile }, identityFieldCheck: { findFirst: async (a: any) => { assert.deepEqual(a.where, { userId: 'u', party }); assert.deepEqual(a.orderBy, { seq: 'desc' }); return check; } } };
 const svc = new IdentityFieldCheckService({ db, ai: {} as any, fetchImage: async () => { throw Error('read path must not fetch an image'); }, enabled: () => enabled, now: () => new Date() });
 return { svc, user, profile, check, disable: () => enabled = false, reads: () => reads };
}
for (const party of ['CLIENT', 'PROVIDER'] as const) test(`current identity match: ${party} requires a completed exact latest full match`, async () => {
 const f = fixture(party); assert.deepEqual(await f.svc.getCurrentMatch('u', party), { state: 'MATCHED', checkId: 'latest' });
 for (const field of ['fullName', 'birthDate', 'nationalId'] as const) for (const bad of ['MISMATCH', 'COULD_NOT_VERIFY']) {
  f.check.fieldResults = fields(); f.check.fieldResults[field].status = bad;
  assert.equal((await f.svc.getCurrentMatch('u', party)).state, 'NEEDS_REVIEW', `${field}/${bad}`);
 }
 f.check.fieldResults = fields();
 for (const status of ['UNAVAILABLE', 'SKIPPED']) { f.check.status = status; assert.equal((await f.svc.getCurrentMatch('u', party)).state, 'NEEDS_REVIEW'); }
 for (const status of ['QUEUED', 'RUNNING']) { f.check.status = status; assert.equal((await f.svc.getCurrentMatch('u', party)).state, 'CHECKING'); }
});
test('an old matching image or registered name/number/date/document is never eligible', async () => {
 for (const change of [
  (f: ReturnType<typeof fixture>) => f.user.legalName = 'اسم آخر',
  (f: ReturnType<typeof fixture>) => f.profile.idNumber = '29001011234568',
  (f: ReturnType<typeof fixture>) => f.profile.dob = new Date('1991-01-01'),
  (f: ReturnType<typeof fixture>) => f.profile.frontIdUrl += '-new',
  (f: ReturnType<typeof fixture>) => f.profile.idDocumentType = 'PASSPORT',
  (f: ReturnType<typeof fixture>) => f.profile.idIssuingCountry = 'SA',
 ]) { const f = fixture(); change(f); assert.equal((await f.svc.getCurrentMatch('u', 'CLIENT')).state, 'NOT_CHECKED'); }
});
test('missing input or disabled checking never opens progression; cosmetic canonical name correction keeps the same evidence', async () => {
 const f = fixture(); f.disable(); assert.equal((await f.svc.getCurrentMatch('u', 'CLIENT')).state, 'NOT_CHECKED'); assert.equal(f.reads(), 0);
 for (const key of ['frontIdUrl', 'idNumber'] as const) { const q = fixture(); q.profile[key] = ''; assert.equal((await q.svc.getCurrentMatch('u', 'CLIENT')).state, 'NOT_CHECKED'); }
 const missing = fixture(); missing.user.legalName = ''; assert.equal((await missing.svc.getCurrentMatch('u', 'CLIENT')).state, 'NOT_CHECKED');
 const canonical = fixture(); canonical.user.legalName = 'عَمْرو محمود'; assert.equal((await canonical.svc.getCurrentMatch('u', 'CLIENT')).state, 'MATCHED');
});
