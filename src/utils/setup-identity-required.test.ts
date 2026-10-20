import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupIdentityFront } from './setup-identity-required';

const own = (u: string, n = 'front') => `private:image:png:waseetai/providers/${u}/identity/${n}`;
const png = 'data:image/png;base64,AAAA';
const U = 'u1';
const base = { userId: U, frontId: undefined as unknown, storedFront: null as string | null, kycStatus: 'UNVERIFIED' as string | null, exists: async () => true };
const refuses = (over: object, code: string) => assert.rejects(() => assertSetupIdentityFront({ ...base, ...over }), (e: any) => e.statusCode === 400 && e.errors[0].field === 'identity.frontId' && e.errors[0].code === code);

test('no front anywhere (nothing stored, review not started): the submission is refused', async () => {
	for (const frontId of [undefined, null, '', '   ']) await refuses({ frontId }, 'DOCUMENT_REQUIRED');
});
test('a stored front, or an identity review already running / decided, satisfies the rule without a new file', async () => {
	await assertSetupIdentityFront({ ...base, storedFront: own(U) });
	for (const kycStatus of ['PENDING', 'VERIFIED']) await assertSetupIdentityFront({ ...base, kycStatus });
	await refuses({ kycStatus: 'REJECTED' }, 'DOCUMENT_REQUIRED');
});
test('a new front must be an allowed data URI or the caller\'s own EXISTING private reference', async () => {
	await assertSetupIdentityFront({ ...base, frontId: png });
	await assertSetupIdentityFront({ ...base, frontId: own(U) });
	for (const frontId of [own('u2'), 'https://evil.example/id.png', 'id.png', 'data:text/html;base64,AAAA', 'data:application/zip;base64,AAAA']) await refuses({ frontId }, 'DOCUMENT_INVALID');
	await refuses({ frontId: own(U, 'gone'), exists: async (r: string) => !r.endsWith('/gone') }, 'DOCUMENT_INVALID');
	await assert.rejects(() => assertSetupIdentityFront({ ...base, frontId: own(U), exists: async () => { throw new Error('down'); } }), (e: any) => e.statusCode === 503);
});
test('re-sending the stored value unchanged is "keep" (no new link, no storage call)', async () => {
	await assertSetupIdentityFront({ ...base, frontId: 'legacy-name.png', storedFront: 'legacy-name.png', exists: async () => { throw new Error('must not be called'); } });
});
