import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupIdentityFront } from './setup-identity-required';

const own = (u: string, n = 'front') => `private:image:png:waseetai/providers/${u}/identity/${n}`;
const png = 'data:image/png;base64,AAAA';
const U = 'u1';
const base = { userId: U, frontId: undefined as unknown, storedFront: null as string | null, exists: async () => true };
const refuses = (over: object, code: string) => assert.rejects(() => assertSetupIdentityFront({ ...base, ...over }), (e: any) => e.statusCode === 400 && e.errors[0].field === 'identity.frontId' && e.errors[0].code === code);

test('no front anywhere (nothing stored, review not started): the submission is refused', async () => {
	for (const frontId of [undefined, null, '', '   ']) await refuses({ frontId }, 'DOCUMENT_REQUIRED');
});
test('a stored front that is a real document satisfies the rule; a review STATUS (PENDING / VERIFIED) is never evidence', async () => {
	await assertSetupIdentityFront({ ...base, storedFront: own(U) });
	await assertSetupIdentityFront({ ...base, storedFront: 'legacy-IMG_1.jpg' });
	// an account can be PENDING with no document at all: nothing stored -> refused whatever its status says (the status is not even an input any more)
	await refuses({ storedFront: null }, 'DOCUMENT_REQUIRED');
	await refuses({ storedFront: '' }, 'DOCUMENT_REQUIRED');
	await refuses({ storedFront: '   ' }, 'DOCUMENT_REQUIRED');
});
test('a stored private front must still be the provider\'s own and EXIST in the storage', async () => {
	await refuses({ storedFront: own('u2') }, 'DOCUMENT_REQUIRED');
	await refuses({ storedFront: own(U, 'gone'), exists: async (r: string) => !r.endsWith('/gone') }, 'DOCUMENT_REQUIRED');
	await assert.rejects(() => assertSetupIdentityFront({ ...base, storedFront: own(U), exists: async () => { throw new Error('down'); } }), (e: any) => e.statusCode === 503);
});
test('a new front must be an allowed data URI or the caller\'s own EXISTING private reference', async () => {
	await assertSetupIdentityFront({ ...base, frontId: png });
	await assertSetupIdentityFront({ ...base, frontId: own(U) });
	for (const frontId of [own('u2'), 'https://evil.example/id.png', 'id.png', 'data:text/html;base64,AAAA', 'data:application/zip;base64,AAAA']) await refuses({ frontId }, 'DOCUMENT_INVALID');
	await refuses({ frontId: own(U, 'gone'), exists: async (r: string) => !r.endsWith('/gone') }, 'DOCUMENT_INVALID');
	await assert.rejects(() => assertSetupIdentityFront({ ...base, frontId: own(U), exists: async () => { throw new Error('down'); } }), (e: any) => e.statusCode === 503);
});
test('re-sending the stored value unchanged is "keep" (no new link; a legacy value needs no storage call, a stored private one must exist)', async () => {
	await assertSetupIdentityFront({ ...base, frontId: 'legacy-name.png', storedFront: 'legacy-name.png', exists: async () => { throw new Error('must not be called'); } });
	await refuses({ frontId: own(U, 'gone'), storedFront: own(U, 'gone'), exists: async () => false }, 'DOCUMENT_REQUIRED');
});

test('an identity document on file elsewhere counts: the approved account document or the ID document of a DOCUMENTS request waiting for the admin (owned + existing only)', async () => {
	await assertSetupIdentityFront({ ...base, storedFront: null, otherStored: [null, own(U, 'waiting-request')] });
	await assertSetupIdentityFront({ ...base, storedFront: null, otherStored: ['legacy-account-doc.pdf'] });
	await refuses({ storedFront: null, otherStored: [own('u2', 'x')] }, 'DOCUMENT_REQUIRED'); // someone else's file is not this provider's document
	await refuses({ storedFront: null, otherStored: [own(U, 'gone')], exists: async (r: string) => !r.endsWith('/gone') }, 'DOCUMENT_REQUIRED');
	await refuses({ storedFront: null, otherStored: [null, '', '  '] }, 'DOCUMENT_REQUIRED');
});
