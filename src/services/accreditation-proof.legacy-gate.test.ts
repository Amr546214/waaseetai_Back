import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertLegacySpecialtyProofs, PROOF_REQUIRED_MESSAGE, proofStorage } from './accreditation-proof.service';

// C4: the older multi-sample submit paths obey the same proof rule as the main approval request.
const PS = 'ps-1';
const own = (name = 'a') => `private:image:png:waseetai/specialties/${PS}/proofs/${name}`;
// fake database + fake storage: the gate must consult both (ownership of the specialty, the upload registry, the storage stat check)
const fakeDb = (o: { owned?: boolean; uploads?: any[]; elsewhere?: number } = {}) => {
	const calls: string[] = [];
	return {
		calls,
		providerSpecialty: { findFirst: async () => { calls.push('ps'); return o.owned === false ? null : { id: PS }; } },
		accreditationProofUpload: { findMany: async (a: any) => { calls.push('uploads'); return (o.uploads ?? []).filter(u => (a.where.privateRef ? u.privateRef === a.where.privateRef : u.status === a.where.status)); } },
		proofAttachment: { count: async () => o.elsewhere ?? 0 }
	} as any;
};
const withStorage = async (present: (r: string) => boolean, fn: () => Promise<void>) => {
	const prev = proofStorage.exists; proofStorage.exists = async r => present(r);
	try { await fn(); } finally { proofStorage.exists = prev; }
};
const code = (e: any) => e?.statusCode;
const field = (e: any) => e?.errors?.[0]?.field;
const run = (db: any, refs: unknown[]) => assertLegacySpecialtyProofs(db, { userId: 'u', providerSpecialtyId: PS, proofRefs: refs });

test('no proof at all: 400 on the files field with the required message', async () => {
	await withStorage(() => true, async () => {
		await assert.rejects(run(fakeDb(), []), (e: any) => code(e) === 400 && field(e) === 'files' && e.message === PROOF_REQUIRED_MESSAGE);
		await assert.rejects(run(fakeDb(), [undefined, null, '']), (e: any) => code(e) === 400);
	});
});

test('a legacy-stored proof (no upload row) in this specialty folder that EXISTS in storage and belongs to the caller is accepted', async () => {
	await withStorage(() => true, async () => assert.deepEqual(await run(fakeDb(), [own()]), { fresh: 1, existing: 0 }));
});

test('the same path is refused when the file is missing in storage', async () => {
	await withStorage(() => false, async () => await assert.rejects(run(fakeDb(), [own()]), (e: any) => code(e) === 400 && field(e) === 'files'));
});

test('someone else\'s specialty (not owned) is refused even if the path is well formed and the file exists', async () => {
	await withStorage(() => true, async () => await assert.rejects(run(fakeDb({ owned: false }), [own()]), (e: any) => code(e) === 400));
});

test('arbitrary links / data URIs / other folders / foreign registry rows are refused, even next to a valid one', async () => {
	const foreign = own('reg');
	for (const [bad, db] of [
		['private:image:png:waseetai/specialties/ps-OTHER/proofs/x', fakeDb()],
		['https://evil.example/x.png', fakeDb()], ['data:image/png;base64,AAAA', fakeDb()],
		['private:image:png:waseetai/accreditation/ps-1x/proofs/x', fakeDb()],
		['private:image:png:waseetai/specialties/ps-1/samples/x', fakeDb()],
		[foreign, fakeDb({ uploads: [{ privateRef: foreign, userId: 'someone-else', providerSpecialtyId: PS, status: 'COMPLETED' }] })],
		[foreign, fakeDb({ uploads: [{ privateRef: foreign, userId: 'u', providerSpecialtyId: PS, status: 'FAILED' }] })],
		[foreign, fakeDb({ uploads: [{ privateRef: foreign, userId: 'u', providerSpecialtyId: PS, status: 'UPLOADING' }] })],
		[foreign, fakeDb({ elsewhere: 1 })]
	] as [string, any][]) {
		await withStorage(() => true, async () => await assert.rejects(run(db, [own(), bad]), (e: any) => code(e) === 400 && field(e) === 'files', bad));
	}
});

test('edit: no new file but a COMPLETED owned upload still present in storage is accepted; one missing in storage is not', async () => {
	const ref = 'private:image:png:waseetai/accreditation/u/proofs/e1';
	const db = () => fakeDb({ uploads: [{ privateRef: ref, userId: 'u', providerSpecialtyId: PS, status: 'COMPLETED' }] });
	await withStorage(() => true, async () => assert.deepEqual(await run(db(), []), { fresh: 0, existing: 1 }));
	await withStorage(() => false, async () => await assert.rejects(run(db(), []), (e: any) => code(e) === 400 && e.message === PROOF_REQUIRED_MESSAGE));
});

test('both legacy submit paths call the gate BEFORE they touch the samples or the specialty status', () => {
	const route = fs.readFileSync(path.join(__dirname, '../routes/provider-specialty.routes.ts'), 'utf8');
	assert.ok(route.indexOf('assertLegacySpecialtyProofs(') > 0 && route.indexOf('assertLegacySpecialtyProofs(') < route.indexOf('tx.workSample.deleteMany'));
	const svc = fs.readFileSync(path.join(__dirname, 'specialty.service.ts'), 'utf8');
	const start = svc.indexOf('async uploadWorkSamples');
	assert.ok(svc.indexOf('assertLegacySpecialtyProofs(', start) > start && svc.indexOf('assertLegacySpecialtyProofs(', start) < svc.indexOf('tx.workSample.deleteMany', start));
});
