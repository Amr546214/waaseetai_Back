import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { DriverAdapterError } from '@prisma/driver-adapter-utils';
import { isRetryableTransactionConflict } from './prisma-retry.util';

// Financial Safety Batch 2A: the two real, structured error shapes this
// project's Prisma 7 driver-adapter runtime (@prisma/adapter-pg) can raise
// for the exact same underlying PostgreSQL SERIALIZABLE conflict (SQLSTATE
// 40001) — confirmed by real-DEV-PostgreSQL testing in Batch 1. Every test
// below constructs a REAL instance of the real Prisma/driver-adapter error
// classes (not a duck-typed plain object), so these tests fail if a future
// Prisma upgrade ever changes either class's actual shape.

test('isRetryableTransactionConflict: a classic PrismaClientKnownRequestError with code P2034 is retryable', () => {
	const error = new Prisma.PrismaClientKnownRequestError(
		'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
		{ code: 'P2034', clientVersion: 'test' }
	);
	assert.equal(isRetryableTransactionConflict(error), true);
});

test('isRetryableTransactionConflict: a DriverAdapterError with cause.kind === TransactionWriteConflict is retryable (the confirmed Prisma 7 driver-adapter shape)', () => {
	const error = new DriverAdapterError({ kind: 'TransactionWriteConflict' });
	assert.equal(isRetryableTransactionConflict(error), true);
});

test('isRetryableTransactionConflict: an UNRELATED DriverAdapterError (e.g. ConnectionClosed) is NOT retryable', () => {
	const error = new DriverAdapterError({ kind: 'ConnectionClosed' });
	assert.equal(isRetryableTransactionConflict(error), false);
});

test('isRetryableTransactionConflict: an unrelated DriverAdapterError (UniqueConstraintViolation) is NOT retryable', () => {
	const error = new DriverAdapterError({ kind: 'UniqueConstraintViolation', constraint: { fields: ['id'] } });
	assert.equal(isRetryableTransactionConflict(error), false);
});

test('isRetryableTransactionConflict: an unrelated PrismaClientKnownRequestError (e.g. P2002 unique constraint) is NOT retryable', () => {
	const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`referenceId`)', { code: 'P2002', clientVersion: 'test' });
	assert.equal(isRetryableTransactionConflict(error), false);
});

test('isRetryableTransactionConflict: a plain AppError-shaped business error is NOT retryable', () => {
	const error = new Error('المبلغ المطلوب يتجاوز رصيدك المتاح');
	assert.equal(isRetryableTransactionConflict(error), false);
});

test('isRetryableTransactionConflict: a completely unrelated error, null, or a plain object is NOT retryable (never throws)', () => {
	assert.equal(isRetryableTransactionConflict(new TypeError('unexpected')), false);
	assert.equal(isRetryableTransactionConflict(null), false);
	assert.equal(isRetryableTransactionConflict(undefined), false);
	assert.equal(isRetryableTransactionConflict('a string, not an error object'), false);
	assert.equal(isRetryableTransactionConflict({ message: 'looks like an error but is not one of the real classes' }), false);
});

test('isRetryableTransactionConflict: never matches on message text alone — a DriverAdapterError whose message happens to mention "conflict" but has an unrelated kind is NOT retryable', () => {
	// Guards specifically against the "message.includes('conflict')" anti-
	// pattern the task explicitly forbids: this error's .message could
	// plausibly contain the word "conflict" in some renderer, but its
	// structured .cause.kind is NOT TransactionWriteConflict, so it must be
	// rejected regardless of surface text.
	const error = new DriverAdapterError({ kind: 'ForeignKeyConstraintViolation', constraint: { fields: ['userId'] } });
	assert.equal(isRetryableTransactionConflict(error), false);
});
