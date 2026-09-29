import { randomUUID } from 'crypto';
import { Prisma, WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateWithdrawalInput, RejectWithdrawalInput, ResolveWithdrawalInput } from '../dtos/withdrawal.dto';
import { providerFinanceService } from './provider-finance.service';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';
import { deriveWithdrawalReferenceId } from '../utils/withdrawal-reference.util';

const MAX_SERIALIZATION_RETRIES = 3;

export class WithdrawalService {
  /**
   * Provider balance is COMPUTED from Escrow.releasedAmount, not a stored
   * field — so unlike depositEscrow()'s/PayPal's conditional-decrement
   * pattern, there is no single row to atomically guard here. Instead the
   * whole read-check-create sequence (released earnings, existing
   * outstanding withdrawals, and the new Withdrawal insert) runs as ONE
   * SERIALIZABLE transaction. Under plain READ COMMITTED (Prisma's
   * default), two concurrent calls for the same provider could both read
   * the same "not yet reserved" outstanding sum and both succeed, together
   * exceeding what was actually released — a plain $transaction wrapper
   * alone does not prevent this, since each transaction would still see its
   * own consistent-but-stale snapshot. SERIALIZABLE makes Postgres itself
   * detect the read (withdrawal.aggregate) / write (withdrawal.create)
   * conflict between the two and abort one of them; that loser is retried
   * here, re-reading the now-current state, rather than treated as an
   * error — see isRetryableTransactionConflict() for exactly which error
   * shapes this project's Prisma 7 driver-adapter runtime can raise for
   * that conflict, and why both are checked, not just the classic P2034.
   *
   * Request-hygiene fix (financial invariant audit): this used to sum only
   * PENDING withdrawals against availableBalance, so the instant an
   * existing request moved to APPROVED/PROCESSING/COMPLETED it silently
   * dropped out of this check — freeing phantom room for a NEW request that
   * could never actually be approved (approve()'s own, separate check would
   * correctly reject it later, so no money was ever overpaid, but the
   * provider could pile up requests already provably unfundable). The
   * canonical creation invariant is now: SUM(amount) over every
   * NON-REJECTED status (PENDING, APPROVED, PROCESSING, COMPLETED) + the
   * new request's amount must not exceed availableBalance — REJECTED is the
   * only status that never reserves balance.
   */
  async createForProvider(userId: string, input: CreateWithdrawalInput) {
    // Generated ONCE per call, outside the retry loop — every retry attempt
    // of THIS creation call reuses the identical id/referenceId pair. Only
    // one attempt's INSERT can ever actually commit (Postgres rolls back
    // every doomed attempt's writes in full, including the row itself), so
    // this never risks two logical referenceIds ending up attached to one
    // successfully-created withdrawal; it simply keeps the identity of "the
    // withdrawal this call is trying to create" stable across retries of
    // the same logical attempt, rather than re-rolling it pointlessly.
    const withdrawalId = randomUUID();
    const referenceId = deriveWithdrawalReferenceId(withdrawalId);

    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          // Reads via `tx`, not the global `prisma` — the released-earnings
          // computation must be part of the same serializable snapshot as
          // the outstanding-withdrawals read and the insert below, not a
          // read taken from outside the transaction.
          const wallet = await providerFinanceService.getWallet(userId, tx);
          const availableBalance = wallet.summary.availableBalance;
          if (input.amount > availableBalance) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك المتاح (${availableBalance} $)`, 400);
          }
          const outstandingWithdrawals = await tx.withdrawal.aggregate({
            where: { userId, status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED] } },
            _sum: { amount: true },
          });
          const outstandingAmount = outstandingWithdrawals._sum.amount || 0;
          const withdrawable = availableBalance - outstandingAmount;
          if (input.amount > withdrawable) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك الصافي بعد طلبات السحب المعلقة (${withdrawable} $)`, 400);
          }
          return tx.withdrawal.create({
            data: {
              id: withdrawalId,
              // WalletTransaction defense-in-depth (financial invariant
              // audit follow-up): every new withdrawal now gets a real,
              // non-null, deterministic referenceId derived from its own
              // id, instead of the historical always-null default. approve()
              // passes this SAME value through to WalletTransaction.referenceId
              // unchanged, so WalletTransaction.referenceId's existing
              // @unique constraint becomes a live DB-level second line of
              // defense against a duplicate debit — independent of, and in
              // addition to, the application-level conditional PENDING ->
              // APPROVED transition that already guarantees exactly-once
              // approval. Historical rows created before this change keep
              // their null referenceId untouched; this only affects newly
              // created withdrawals.
              referenceId,
              userId,
              amount: input.amount,
              currency: 'USD', // new withdrawal requests are USD — never rely on the
              // schema's historical 'SAR' default. Existing rows keep whatever
              // currency they were created with; this only affects new creates.
              method: input.method,
              accountName: input.accountName || null,
              accountNumber: input.accountNumber || null,
              iban: input.iban || null,
              status: WithdrawalStatus.PENDING,
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        // Bounded retry, and ONLY for a recognized transaction-conflict
        // shape (see isRetryableTransactionConflict) — every other error,
        // including the plain AppError validation-rejection thrown inside
        // the transaction above, propagates immediately and unmodified.
        if (isRetryableTransactionConflict(error) && attempt < MAX_SERIALIZATION_RETRIES) continue;
        throw error;
      }
    }
    // Unreachable in practice — the loop above always returns or throws on
    // its final attempt — kept only to satisfy TypeScript's control-flow
    // analysis without an unsafe non-null assertion.
    throw new AppError('تعذر إنشاء طلب السحب بعد عدة محاولات متزامنة، حاول مرة أخرى', 409);
  }

  async listForUser(userId: string, status?: WithdrawalStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const where = { userId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      prisma.withdrawal.count({ where }),
    ]);
    return {
      items,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async list(status?: WithdrawalStatus, page = 1, limit = 20) {
    const safePage = Math.max(1, page); const safeLimit = Math.min(100, Math.max(1, limit));
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      prisma.withdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, accountType: true } }, reviewedBy: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.withdrawal.count({ where })
    ]);
    return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
  }

  async get(id: string) {
    const item = await prisma.withdrawal.findUnique({ where: { id }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, accountType: true, walletBalance: true, ibanNumber: true, bankName: true } }, reviewedBy: { select: { id: true, firstName: true, lastName: true } } } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    return item;
  }

  /**
   * Balance-overspend race (found during the Payout P1 audit, fixed here):
   * the withdrawable-balance eligibility check used to run OUTSIDE any
   * transaction, using the global `prisma` client. Two different PENDING
   * withdrawals for the SAME provider, approved concurrently by two admins,
   * could each independently read the same "not yet committed" withdrawn
   * total, each individually pass the check, and both proceed — the
   * per-row `{ id, status: PENDING }` conditional update doesn't catch this,
   * since the two approvals target two DIFFERENT rows and never conflict
   * with each other there. Combined, their approved amounts could exceed
   * the provider's real withdrawable balance.
   *
   * Fixed the same way createForProvider() already protects its own
   * balance check: the wallet read, the "already withdrawn" aggregate, AND
   * the conditional status transition now all run inside ONE SERIALIZABLE
   * transaction. Two concurrent approve() calls for the same provider both
   * read the withdrawal table's {APPROVED,COMPLETED} aggregate for that
   * userId, and each is about to WRITE a row into that same set — a genuine
   * read/write dependency Postgres's serializable snapshot isolation
   * detects and aborts one side of, exactly like createForProvider()'s own
   * concurrent-create protection. The loser is retried here (bounded, via
   * the same isRetryableTransactionConflict() classifier as Batch 2A/
   * createForProvider() — not a weaker P2034-only check), and because the
   * retry re-runs this entire transaction body from scratch, it re-reads
   * the wallet balance and the withdrawn aggregate fresh, now seeing the
   * winner's committed APPROVED row — so a retry that would overspend fails
   * with the same clean AppError, not a raw technical conflict.
   *
   * Two different providers never conflict here: SERIALIZABLE/SSI in
   * Postgres detects conflicts based on actual overlapping read/write sets,
   * and every query in this transaction is scoped by `userId`/`id` — two
   * providers' approvals touch disjoint rows and proceed independently,
   * matching createForProvider()'s already-established behavior.
   */
  async approve(id: string, adminId: string, input: ResolveWithdrawalInput) {
    const item = await prisma.withdrawal.findUnique({ where: { id } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    if (item.status !== WithdrawalStatus.PENDING) throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);

    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          // Reads via `tx`, not the global `prisma` — the balance
          // eligibility check must be part of the SAME serializable
          // snapshot as the conditional status transition below, not a
          // read taken from outside the transaction.
          const wallet = await providerFinanceService.getWallet(item.userId, tx);
          const availableBalance = wallet.summary.availableBalance;
          const alreadyWithdrawn = await tx.withdrawal.aggregate({
            where: { userId: item.userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.COMPLETED] } },
            _sum: { amount: true },
          });
          const withdrawnAmount = alreadyWithdrawn._sum.amount || 0;
          const withdrawableBalance = availableBalance - withdrawnAmount;
          if (item.amount > withdrawableBalance) {
            throw new AppError(`رصيد المزود غير كافٍ لتنفيذ السحب (المتاح: ${withdrawableBalance} $)`, 400);
          }

          // CRITICAL: guards the TOCTOU race identified in the Payout P1
          // audit — two concurrent approve() calls for the SAME withdrawal
          // could both pass the outer PENDING check above and both reach
          // this point. The conditional updateMany below, not an
          // unconditional update(), is the actual guard: only the caller
          // whose write matches exactly one row (status still PENDING at
          // write time) proceeds to record a debit. The loser sees
          // count !== 1 and rolls back with nothing written — no second
          // WalletTransaction, no partial state.
          const transition = await tx.withdrawal.updateMany({
            where: { id, status: WithdrawalStatus.PENDING },
            data: { status: WithdrawalStatus.APPROVED, reviewedById: adminId, adminNote: input.adminNote },
          });
          if (transition.count !== 1) {
            // Someone else already resolved this withdrawal between our
            // initial read and this write — the same clean,
            // technical-detail-free business error the initial PENDING
            // check above would have thrown had it been re-read at this
            // exact moment. Throwing here rolls back the entire
            // transaction: no WalletTransaction is written.
            throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);
          }
          // Only reached once the conditional transition above has
          // actually succeeded — the debit record is never written for a
          // request that lost the race.
          await tx.walletTransaction.create({ data: { userId: item.userId, type: 'WITHDRAWAL', amount: -item.amount, currency: item.currency, status: 'COMPLETED', paymentMethod: item.method, referenceId: item.referenceId, description: `اعتماد طلب السحب ${item.id}`, metadata: { withdrawalId: item.id } } });
          return tx.withdrawal.findUniqueOrThrow({ where: { id } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        // Bounded retry, and ONLY for a recognized transaction-conflict
        // shape (see isRetryableTransactionConflict) — every other error,
        // including both plain AppError business rejections thrown inside
        // the transaction above (insufficient balance, already resolved),
        // propagates immediately and unmodified.
        if (isRetryableTransactionConflict(error) && attempt < MAX_SERIALIZATION_RETRIES) continue;
        throw error;
      }
    }
    // Unreachable in practice — the loop above always returns or throws on
    // its final attempt — kept only to satisfy TypeScript's control-flow
    // analysis without an unsafe non-null assertion.
    throw new AppError('تعذر اعتماد طلب السحب بعد عدة محاولات متزامنة، حاول مرة أخرى', 409);
  }

  async reject(id: string, adminId: string, input: RejectWithdrawalInput) {
    const item = await prisma.withdrawal.findUnique({ where: { id } });
    if (!item) throw new AppError('طلب السحب غير موجود', 404);
    if (item.status !== WithdrawalStatus.PENDING) throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);
    // Same TOCTOU guard as approve() above, and — since both approve() and
    // reject() gate their conditional write on the identical `status:
    // PENDING` predicate for the same row — this also makes the two methods
    // mutually exclusive of EACH OTHER, not just of themselves: whichever of
    // an approve()/reject() race actually commits first flips status away
    // from PENDING under Postgres's own row lock, so the other's conditional
    // update (whichever method it is) is the one that observes count !== 1.
    // reject() currently has no related audit/side-effect write beyond this
    // transition itself, so there is nothing to sequence after it — the
    // transaction wrapper exists purely to make the read-then-write atomic.
    return prisma.$transaction(async tx => {
      const transition = await tx.withdrawal.updateMany({
        where: { id, status: WithdrawalStatus.PENDING },
        data: { status: WithdrawalStatus.REJECTED, reviewedById: adminId, rejectionReason: input.rejectionReason },
      });
      if (transition.count !== 1) {
        // Someone else (an approve() or a concurrent reject()) already
        // resolved this withdrawal between our initial read and this write.
        // Same clean, technical-detail-free business error as approve()'s
        // equivalent branch — never a raw Prisma/DB error. Throwing here
        // rolls back the entire transaction.
        throw new AppError('طلب السحب تمت معالجته مسبقاً', 409);
      }
      return tx.withdrawal.findUniqueOrThrow({ where: { id } });
    });
  }
}

export const withdrawalService = new WithdrawalService();
