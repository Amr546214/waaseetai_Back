import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupPortfolioProofs, isAcceptableProofLink, isValidSetupProofValue } from './setup-portfolio-proofs';

const own = (u: string) => `private:raw:pdf:waseetai/providers/${u}/documents/work`;
const pdf = 'data:application/pdf;base64,AAAA';

test('setup proofs: own private ref, data URIs and https links are valid; foreign refs, unsafe links and bare strings are not', () => {
	assert.equal(isValidSetupProofValue(own('u1'), 'u1'), true);
	assert.equal(isValidSetupProofValue(own('u2'), 'u1'), false);
	assert.equal(isValidSetupProofValue(pdf, 'u1'), true);
	assert.equal(isValidSetupProofValue('data:text/html;base64,AAAA', 'u1'), false);
	assert.equal(isValidSetupProofValue('https://github.com/user/repo', 'u1'), true);
	for (const bad of ['http://github.com/user/repo', 'javascript:alert(1)', 'https://user:pw@github.com/x', 'https://localhost/x', 'https://' + 'a'.repeat(600) + '.com', 'https://git hub.com/x', 'ftp://x.example/a']) assert.equal(isAcceptableProofLink(bad), false, bad);
	assert.equal(isValidSetupProofValue('', 'u1'), false);
});

test('setup proofs: every chosen sub-specialty needs a valid work file, named in the error; an absent portfolio keeps what is stored', () => {
	assertSetupPortfolioProofs('u1', undefined, ['A']);
	assert.doesNotThrow(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf }] }, ['A']));
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: '' }] }, ['A']), (e: any) => e.statusCode === 400 && e.errors[0].field === 'portfolio.A');
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf }] }, ['A', 'B']), (e: any) => e.errors[0].field === 'portfolio.B');
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: own('u2') }] }, ['A']), (e: any) => e.errors[0].field === 'portfolio.A');
	assert.doesNotThrow(() => assertSetupPortfolioProofs('u1', { A: [{ review: 'https://github.com/u/r', proofs: ['https://github.com/u/r/blob/main/a.png'] }] }, ['A']));
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf, proofs: ['http://x.example/a.png'] }] }, ['A']), (e: any) => e.errors[0].field === 'portfolio.A');
});

test('resolveSetupPortfolio: a link works as the model, as the proof, or both; the same link twice is still refused', async () => {
	const { resolveSetupPortfolio } = await import('./setup-portfolio-proofs');
	const run = (review: string, proofs: string[]) => resolveSetupPortfolio({ userId: 'u1', portfolio: { A: [{ review, proofs }] }, chosenSubSpecs: ['A'], stored: [], exists: async () => true });
	assert.equal((await run('https://github.com/u/r', ['https://github.com/u/r/issues'])).length, 1);
	assert.equal((await run(own('u1'), ['https://github.com/u/r'])).length, 1);
	assert.equal((await run('https://github.com/u/r', [own('u1')])).length, 1);
	await assert.rejects(() => run('https://github.com/u/r', ['https://github.com/u/r']), (e: any) => e.errors[0].code === 'PROOF_REQUIRED');
	await assert.rejects(() => run(own('u1'), ['http://github.com/u/r']), (e: any) => e.errors[0].code === 'PROOF_INVALID');
});
