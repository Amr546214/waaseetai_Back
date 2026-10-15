import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupPortfolioProofs, isValidSetupProofValue } from './setup-portfolio-proofs';

const own = (u: string) => `private:raw:pdf:waseetai/providers/${u}/documents/work`;
const pdf = 'data:application/pdf;base64,AAAA';

test('setup proofs: own private ref and data URIs are valid; foreign refs, external links and bare strings are not', () => {
	assert.equal(isValidSetupProofValue(own('u1'), 'u1'), true);
	assert.equal(isValidSetupProofValue(own('u2'), 'u1'), false);
	assert.equal(isValidSetupProofValue(pdf, 'u1'), true);
	assert.equal(isValidSetupProofValue('data:text/html;base64,AAAA', 'u1'), false);
	assert.equal(isValidSetupProofValue('https://evil.example/x.pdf', 'u1'), false);
	assert.equal(isValidSetupProofValue('', 'u1'), false);
});

test('setup proofs: every chosen sub-specialty needs a valid work file, named in the error; an absent portfolio keeps what is stored', () => {
	assertSetupPortfolioProofs('u1', undefined, ['A']);
	assert.doesNotThrow(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf }] }, ['A']));
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: '' }] }, ['A']), (e: any) => e.statusCode === 400 && e.errors[0].field === 'portfolio.A');
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf }] }, ['A', 'B']), (e: any) => e.errors[0].field === 'portfolio.B');
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: own('u2') }] }, ['A']), (e: any) => e.errors[0].field === 'portfolio.A');
	assert.throws(() => assertSetupPortfolioProofs('u1', { A: [{ review: pdf, proofs: ['https://x.example/a.png'] }] }, ['A']), (e: any) => e.errors[0].field === 'portfolio.A');
});
