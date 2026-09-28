import { Prisma } from '@prisma/client';
import { isDriverAdapterError } from '@prisma/driver-adapter-utils';

/**
 * Narrow, structural detector for a genuine PostgreSQL SERIALIZABLE
 * transaction conflict (Postgres SQLSTATE 40001) — the only class of error
 * that is ever safe to blindly retry a whole transaction for, since it
 * means nothing committed and Postgres itself is asking the loser of a
 * race to re-run against the now-current state.
 *
 * This project runs on Prisma 7's driver-adapter architecture
 * (config/db.ts wires PrismaClient to @prisma/adapter-pg), which can
 * surface this exact same underlying Postgres condition through TWO
 * different error shapes — both checked here via structured, typed
 * properties, never by parsing a message string:
 *
 * A. The classic, documented Prisma error — PrismaClientKnownRequestError
 *    with code 'P2034' ("Transaction failed due to a write conflict or a
 *    deadlock. Please retry your transaction").
 *
 * B. A DriverAdapterError (exported by @prisma/driver-adapter-utils, the
 *    package @prisma/adapter-pg itself throws through) whose `cause.kind`
 *    is the literal, publicly-typed union member 'TransactionWriteConflict'
 *    — one of the documented variants of that package's own exported
 *    `MappedError` type (node_modules/@prisma/driver-adapter-utils'
 *    index.d.ts). `isDriverAdapterError` is that same package's own
 *    exported type guard, not a duck-typed check invented here.
 *
 *    Confirmed reproducible against real DEV PostgreSQL (Financial Safety
 *    Batch 1 verification, see withdrawal.service.ts): the classic P2034
 *    path and this path can both occur for the identical underlying
 *    conflict, on otherwise-identical concurrent requests — this appears to
 *    depend on exactly where in the driver-adapter's query pipeline
 *    Postgres's 40001 surfaces, not on anything the caller controls.
 *
 * Deliberately narrow: no `message.includes(...)` checks anywhere, and
 * nothing here treats an unrecognized error as retryable — an error that
 * matches neither shape returns false and must propagate completely
 * normally, unmodified, at the call site.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
	// Prisma's own isDriverAdapterError() is not null-safe — it dereferences
	// `error.name` unconditionally and throws on null/undefined/a non-object
	// value. This predicate must never itself throw (a caller checking
	// "is this retryable?" on an unexpected value must get `false`, not a
	// second, unrelated crash), so non-object values are filtered first.
	if (error === null || typeof error !== 'object') return false;

	if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
		return true;
	}
	if (isDriverAdapterError(error) && error.cause?.kind === 'TransactionWriteConflict') {
		return true;
	}
	return false;
}
