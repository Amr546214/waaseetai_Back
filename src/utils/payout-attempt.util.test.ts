import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSenderBatchId } from './payout-attempt.util';

test('deriveSenderBatchId: is stable for the SAME withdrawalId + attemptNumber (an HTTP retry of the same attempt resolves to the same key)', () => {
	const a = deriveSenderBatchId('withdrawal-1', 1);
	const b = deriveSenderBatchId('withdrawal-1', 1);
	assert.equal(a, b);
});

test('deriveSenderBatchId: is different for a new attemptNumber on the SAME withdrawal (a legitimate retry gets its own key)', () => {
	const first = deriveSenderBatchId('withdrawal-1', 1);
	const retry = deriveSenderBatchId('withdrawal-1', 2);
	assert.notEqual(first, retry);
});

test('deriveSenderBatchId: is different for different withdrawals even at the same attemptNumber', () => {
	const a = deriveSenderBatchId('withdrawal-1', 1);
	const b = deriveSenderBatchId('withdrawal-2', 1);
	assert.notEqual(a, b);
});

test('deriveSenderBatchId: contains no secret material — purely derived from its two inputs, matches the exact approved format', () => {
	const id = deriveSenderBatchId('4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b', 2);
	assert.equal(id, 'wd-4f6a1a2b-c3d4-4e5f-8a9b-0c1d2e3f4a5b-a2');
});

test('deriveSenderBatchId: rejects a missing withdrawalId', () => {
	assert.throws(() => deriveSenderBatchId('', 1));
});

test('deriveSenderBatchId: rejects a non-positive or non-integer attemptNumber', () => {
	assert.throws(() => deriveSenderBatchId('withdrawal-1', 0));
	assert.throws(() => deriveSenderBatchId('withdrawal-1', -1));
	assert.throws(() => deriveSenderBatchId('withdrawal-1', 1.5));
});
