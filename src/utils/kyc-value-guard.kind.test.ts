import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKycFileValue, privateRefKindProblem } from './kyc-value-guard';
import { buildPrivateRef } from './kyc-private-ref';
import { isUploadKind, uploadKindFolder } from './provider-file-guard';

const ref = (folder: string | null, file = 'f-1') => buildPrivateRef({ resourceType: 'image', format: 'png', publicId: `waseetai/providers/u1/documents${folder ? `/${folder}` : ''}/${file}` });

test('upload kinds: all seven are accepted, anything else is not; the folder is the lower-cased kind', () => {
	for (const k of ['ID_DOCUMENT', 'SELFIE', 'CERTIFICATE', 'AVATAR', 'PORTFOLIO_MODEL', 'PORTFOLIO_PROOF', 'BUSINESS_DOCUMENT']) assert.ok(isUploadKind(k));
	for (const k of ['', 'id_document', 'OTHER', undefined, 5]) assert.ok(!isUploadKind(k as never));
	assert.equal(uploadKindFolder('PORTFOLIO_PROOF'), 'portfolio_proof');
});
test('a reference from the right kind folder is accepted; from another kind is refused', () => {
	assert.equal(privateRefKindProblem(ref('id_document'), 'ID_DOCUMENT'), null);
	assert.ok(privateRefKindProblem(ref('portfolio_model'), 'ID_DOCUMENT'));
	assert.ok(privateRefKindProblem(ref('avatar'), 'CERTIFICATE'));
	assert.ok(privateRefKindProblem(ref('certificate'), 'ID_DOCUMENT'));
});
test('legacy references (no kind folder) and non-document folders are still accepted', () => {
	assert.equal(privateRefKindProblem(ref(null), 'ID_DOCUMENT'), null);
	assert.equal(privateRefKindProblem(buildPrivateRef({ resourceType: 'image', format: 'png', publicId: 'waseetai/clients/u1/onboarding/x-1' }), 'ID_DOCUMENT'), null);
});
test('assertKycFileValue: wrong-kind own reference -> 422; right kind / no expectation / unchanged stored value pass; someone else\'s reference is still 400', () => {
	const wrong = ref('portfolio_proof');
	assert.throws(() => assertKycFileValue(wrong, 'u1', [], 'ID_DOCUMENT'), (e: any) => e.statusCode === 422);
	assert.doesNotThrow(() => assertKycFileValue(ref('id_document'), 'u1', [], 'ID_DOCUMENT'));
	assert.doesNotThrow(() => assertKycFileValue(wrong, 'u1', []));
	assert.doesNotThrow(() => assertKycFileValue(wrong, 'u1', [wrong], 'ID_DOCUMENT'));
	assert.throws(() => assertKycFileValue(ref('id_document'), 'u2', [], 'ID_DOCUMENT'), (e: any) => e.statusCode === 400);
});
