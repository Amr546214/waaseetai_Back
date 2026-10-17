import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertLegacySpecialtyProofs, PROOF_REQUIRED_MESSAGE } from './accreditation-proof.service';

// C4: the older multi-sample submit paths obey the same proof rule as the main approval request.
const PS = 'ps-1';
const own = (name = 'a') => `private:image:png:waseetai/specialties/${PS}/proofs/${name}`;
const fakeDb = (existing = 0) => { const calls: any[] = []; return { calls, accreditationProofUpload: { count: async (a: any) => { calls.push(a); return existing; } } } as any; };
const code = (e: any) => e?.statusCode;
const field = (e: any) => e?.errors?.[0]?.field;

test('no proof at all (no new file, nothing completed on file): 400 on the files field with the required message', async () => {
	await assert.rejects(assertLegacySpecialtyProofs(fakeDb(0), { userId: 'u', providerSpecialtyId: PS, proofRefs: [] }), (e: any) => code(e) === 400 && field(e) === 'files' && e.message === PROOF_REQUIRED_MESSAGE);
	await assert.rejects(assertLegacySpecialtyProofs(fakeDb(0), { userId: 'u', providerSpecialtyId: PS, proofRefs: [undefined, null, ''] }), (e: any) => code(e) === 400);
});

test('a stored private proof inside THIS specialty folder is accepted without touching the database', async () => {
	const db = fakeDb(0);
	assert.deepEqual(await assertLegacySpecialtyProofs(db, { userId: 'u', providerSpecialtyId: PS, proofRefs: [own()] }), { fresh: 1, existing: 0 });
	assert.equal(db.calls.length, 0);
});

test('a proof of another specialty / a plain URL / a data URI is refused, even next to a valid one', async () => {
	for (const bad of ['private:image:png:waseetai/specialties/ps-OTHER/proofs/x', 'https://evil.example/x.png', 'data:image/png;base64,AAAA', 'private:image:png:waseetai/accreditation/ps-1x/proofs/x']) {
		await assert.rejects(assertLegacySpecialtyProofs(fakeDb(5), { userId: 'u', providerSpecialtyId: PS, proofRefs: [own(), bad] }), (e: any) => code(e) === 400 && field(e) === 'files', bad);
	}
});

test('edit: no new file but a COMPLETED owned proof already on file for this request is accepted (counted by user + request + COMPLETED only)', async () => {
	const db = fakeDb(2);
	assert.deepEqual(await assertLegacySpecialtyProofs(db, { userId: 'u', providerSpecialtyId: PS, proofRefs: [] }), { fresh: 0, existing: 2 });
	assert.deepEqual(db.calls[0].where, { userId: 'u', providerSpecialtyId: PS, status: 'COMPLETED' });
});

test('both legacy submit paths call the gate BEFORE they touch the samples or the specialty status', () => {
	const route = fs.readFileSync(path.join(__dirname, '../routes/provider-specialty.routes.ts'), 'utf8');
	assert.ok(route.indexOf('assertLegacySpecialtyProofs(') > 0 && route.indexOf('assertLegacySpecialtyProofs(') < route.indexOf('tx.workSample.deleteMany'));
	const svc = fs.readFileSync(path.join(__dirname, 'specialty.service.ts'), 'utf8');
	const start = svc.indexOf('async uploadWorkSamples');
	assert.ok(svc.indexOf('assertLegacySpecialtyProofs(', start) > start && svc.indexOf('assertLegacySpecialtyProofs(', start) < svc.indexOf('tx.workSample.deleteMany', start));
});
