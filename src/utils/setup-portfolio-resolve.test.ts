import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetupPortfolio, StoredPortfolioRow } from './setup-portfolio-proofs';

// Setup step 5 (business models): every chosen sub-specialty needs a model FILE and, for that model, at least one completed, owned, existing PROOF of ownership
// that is a different file. The work file is never a substitute for its proof. Existing proofs are kept through the stored row (id + keep flags),
// never through a link shape. Everything is decided BEFORE any write.
const own = (u: string, n = 'p1') => `private:raw:pdf:waseetai/providers/${u}/documents/${n}`;
const pdf = 'data:application/pdf;base64,AAAA';
const U = 'u1';
const existsAll = async () => true;
const model = (spec: string) => `نموذج أعمال - ${spec}`;
const row = (over: Partial<StoredPortfolioRow> = {}): StoredPortfolioRow => ({ id: 'row-1', title: model('A'), description: own(U, 'work'), tags: [own(U, 'proof')], coverImage: null, ...over });
const run = (portfolio: unknown, subs: string[], stored: StoredPortfolioRow[] = [], exists = existsAll) => resolveSetupPortfolio({ userId: U, portfolio, chosenSubSpecs: subs, stored, exists });
const fails = async (p: Promise<unknown>, field: string, code: string) => assert.rejects(p, (e: any) => e.statusCode === 400 && e.errors?.[0]?.field === field && e.errors?.[0]?.code === code);

test('a model file with a proof is accepted and resolved per sub-specialty', async () => {
	const out = await run({ A: [{ review: own(U, 'w'), proofs: [own(U, 'p')] }] }, ['A']);
	assert.deepEqual(out, [{ spec: 'A', review: own(U, 'w'), proofs: [own(U, 'p')] }]);
	assert.equal((await run({ A: [{ review: pdf, proofs: [pdf.replace('AAAA', 'BBBB')] }] }, ['A'])).length, 1, 'data URIs (the server uploads them) are accepted');
});

test('missing proof: no proofs, an empty list, blanks or only an empty upload placeholder', async () => {
	for (const proofs of [undefined, [], [''], ['   ']]) await fails(run({ A: [{ review: own(U, 'w'), proofs }] }, ['A']), 'portfolio.A', 'PROOF_REQUIRED');
});

test('the model file is NOT a proof: the same file as proof is refused, and a proof alone (no model file) is refused', async () => {
	await fails(run({ A: [{ review: own(U, 'w'), proofs: [own(U, 'w')] }] }, ['A']), 'portfolio.A', 'PROOF_REQUIRED');
	await fails(run({ A: [{ review: '', proofs: [own(U, 'p')] }] }, ['A']), 'portfolio.A', 'MODEL_FILE_REQUIRED');
});

test('every chosen sub-specialty is checked, and an extra model without a proof is refused too', async () => {
	await fails(run({ A: [{ review: pdf, proofs: [pdf.replace('AAAA', 'CCCC')] }] }, ['A', 'B']), 'portfolio.B', 'MODEL_FILE_REQUIRED');
	await fails(run({ A: [{ review: own(U, 'w1'), proofs: [own(U, 'p1')] }, { review: own(U, 'w2'), proofs: [] }] }, ['A']), 'portfolio.A', 'PROOF_REQUIRED');
	await fails(run({ A: [{ review: own(U, 'w1'), proofs: [own(U, 'p1')] }] }, ['A', 'B']), 'portfolio.B', 'MODEL_FILE_REQUIRED');
});

test('a proof must be a real, owned file: foreign account, arbitrary link, bare string, forbidden data type are refused', async () => {
	for (const proof of [own('u2'), 'https://evil.example/p.pdf', 'p.pdf', 'data:text/html;base64,AAAA', 'https://res.cloudinary.com/x/image/upload/v1/waseetai/providers/u2/documents/p.pdf']) {
		await fails(run({ A: [{ review: pdf, proofs: [proof] }] }, ['A']), 'portfolio.A', 'PROOF_INVALID');
	}
});

test('existence is verified against the storage: a private reference that is not there (upload never completed) is refused, and a storage failure fails closed', async () => {
	await fails(run({ A: [{ review: pdf, proofs: [own(U, 'gone')] }] }, ['A'], [], async ref => !ref.endsWith('/gone')), 'portfolio.A', 'PROOF_INVALID');
	await fails(run({ A: [{ review: own(U, 'gone'), proofs: [pdf] }] }, ['A'], [], async ref => !ref.endsWith('/gone')), 'portfolio.A', 'PROOF_INVALID');
	await assert.rejects(run({ A: [{ review: pdf, proofs: [own(U, 'x')] }] }, ['A'], [], async () => { throw new Error('storage down'); }), (e: any) => e.statusCode === 503);
});

test('stored files are kept through the stored row (id + keep flags); a foreign / unknown id keeps nothing', async () => {
	const stored = [row()];
	const kept = await run({ A: [{ id: 'row-1', keepReview: true, keepProofs: [0] }] }, ['A'], stored);
	assert.deepEqual(kept, [{ spec: 'A', review: own(U, 'work'), proofs: [own(U, 'proof')] }]);
	const mixed = await run({ A: [{ id: 'row-1', keepReview: true, keepProofs: [0], proofs: [pdf] }] }, ['A'], stored);
	assert.deepEqual(mixed[0].proofs, [own(U, 'proof'), pdf]);
	await fails(run({ A: [{ id: 'row-1', keepReview: true, keepProofs: [] }] }, ['A'], stored), 'portfolio.A', 'PROOF_REQUIRED');
	await fails(run({ A: [{ id: 'row-9', keepReview: true, keepProofs: [0] }] }, ['A'], stored), 'portfolio.A', 'MODEL_FILE_REQUIRED');
	await fails(run({ B: [{ id: 'row-1', keepReview: true, keepProofs: [0] }] }, ['B'], stored), 'portfolio.B', 'MODEL_FILE_REQUIRED'); // the row belongs to another sub-specialty
	await fails(run({ A: [{ id: 'row-1', keepReview: true, keepProofs: [5] }] }, ['A'], stored), 'portfolio.A', 'PROOF_REQUIRED');
});

test('legacy public files that this provider already has stored are accepted as proofs when sent back unchanged (and only those)', async () => {
	const legacy = `https://res.cloudinary.com/demo/image/upload/v1/waseetai/providers/${U}/portfolio/A-1.png`;
	process.env.CLOUDINARY_CLOUD_NAME = 'demo';
	const stored = [row({ description: pdf, tags: [legacy] })];
	assert.equal((await run({ A: [{ review: own(U, 'w'), proofs: [legacy] }] }, ['A'], stored)).length, 1);
	await fails(run({ A: [{ review: own(U, 'w'), proofs: [legacy.replace('A-1', 'A-2')] }] }, ['A'], stored), 'portfolio.A', 'PROOF_INVALID');
});

test('shapes: portfolio must be an object of arrays; an absent portfolio is not a submission', async () => {
	await assert.rejects(run([], ['A']), (e: any) => e.statusCode === 400);
	await assert.rejects(run('x', ['A']), (e: any) => e.statusCode === 400);
	assert.deepEqual(await run(undefined, ['A']), []);
});
