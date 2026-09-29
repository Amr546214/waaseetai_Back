import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveWithdrawalReferenceId } from './withdrawal-reference.util';

test('deriveWithdrawalReferenceId: is deterministic — the SAME withdrawalId always produces the SAME referenceId', () => {
	const a = deriveWithdrawalReferenceId('4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b');
	const b = deriveWithdrawalReferenceId('4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b');
	assert.equal(a, b);
});

test('deriveWithdrawalReferenceId: matches the exact approved namespaced format', () => {
	const id = deriveWithdrawalReferenceId('4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b');
	assert.equal(id, 'withdrawal-4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b');
});

test('deriveWithdrawalReferenceId: two different withdrawal ids produce two different referenceIds', () => {
	const a = deriveWithdrawalReferenceId('withdrawal-id-1');
	const b = deriveWithdrawalReferenceId('withdrawal-id-2');
	assert.notEqual(a, b);
});

test('deriveWithdrawalReferenceId: rejects an empty withdrawalId', () => {
	assert.throws(() => deriveWithdrawalReferenceId(''));
});
