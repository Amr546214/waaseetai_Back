import { randomUUID } from 'crypto';
import { Prisma, WithdrawalStatus, CommissionStatus, AccountType, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateWithdrawalInput, CreateMarketerWithdrawalInput, RejectWithdrawalInput, ResolveWithdrawalInput } from '../dtos/withdrawal.dto';
import { providerFinanceService } from './provider-finance.service';
import { isRetryableTransactionConflict } from '../utils/prisma-retry.util';
import { deriveWithdrawalReferenceId } from '../utils/withdrawal-reference.util';

const MAX_SERIALIZATION_RETRIES = 3;

/**
 * Release-blocker fix (marketer withdrawal approval): the Withdrawal table is
 * shared by provider-earnings withdrawals (createForProvider) and
 * affiliate-commission withdrawals (createForMarketer), and the schema has
 * NO per-row source/ledger discriminator. The ledger a withdrawal must be
 * checked against at approval time is therefore resolved from the owning
 * user's identity, mirroring exactly the role-equivalence rules
 * authorize() uses to gate the two creation endpoints:
 *  - a user who is NOT a provider but HAS an AffiliateProfile can only ever
 *    have reached createForMarketer() -> AFFILIATE_COMMISSION ledger
 *    (SUM of APPROVED CommissionLog rows — the authoritative commission
 *    balance the marketer dashboard/createForMarketer() already use);
 *  - every other user (any provider, including a provider who also holds
 *    the AFFILIATE role) -> PROVIDER_EARNINGS ledger, i.e. the pre-existing
 *    provider wallet check, completely unchanged.
 * A user who is both provider and affiliate is ambiguous without a schema
 * discriminator, so createForMarketer() refuses to create commission
 * withdrawals for such users (fail closed) — no commission withdrawal can
 * therefore ever be approved against the provider wallet.
 */
type ApprovalLedger =
  | { kind: 'PROVIDER_EARNINGS' }
  | { kind: 'AFFILIATE_COMMISSION'; affiliateId: string };

function isProviderIdentity(user: { accountType: AccountType; roles: UserRole[] | null; activeRole: UserRole | null }): boolean {
  return user.accountType === AccountType.PROVIDER_INDIVIDUAL
    || user.accountType === AccountType.PROVIDER_COMPANY
    || (user.roles ?? []).includes(UserRole.PROVIDER)
    || user.activeRole === UserRole.PROVIDER;
}

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
   * NON-RELEASING status (PENDING, APPROVED, PROCESSING, COMPLETED,
   * REVERSED) + the new request's amount must not exceed availableBalance —
   * REJECTED is the only status that ever releases its reservation.
   *
   * Payout P3-A hardening: REVERSED (a COMPLETED payout that PayPal later
   * reported RETURNED/REFUNDED/REVERSED) is deliberately included here, NOT
   * treated like REJECTED. A reversal means PayPal took the money back
   * AFTER this withdrawal's earnings were already once paid out — those
   * earnings must stay reserved/blocked from being withdrawn again until an
   * explicit future financial-resolution workflow (not this batch) decides
   * what to do with them. Silently freeing that reservation (as REJECTED
   * correctly does, since a rejected withdrawal genuinely never took any
   * money) would let the SAME underlying earnings be withdrawn a second
   * time — this fix exists specifically to prevent that.
   */
  async createForProvider(userId: string, input: CreateWithdrawalInput) {
    // Payout P2-A: for a PayPal withdrawal, the destination is resolved
    // ONCE, here, from the authenticated provider's own ProviderProfile —
    // NEVER from the request body (createWithdrawalSchema declares no
    // `paypalEmail` field at all, so nothing a caller sends could reach this
    // point anyway) and NEVER from User.email (the login identity is a
    // deliberately separate, unrelated concept from a confirmed PayPal
    // payout address — an explicit owner decision). This read happens
    // BEFORE the retry loop, exactly like the id/referenceId generation
    // below: it is not part of the balance/outstanding-amount invariant the
    // retry loop protects, so there is no reason to re-read it on a
    // SERIALIZABLE retry. An empty-string paypalPayoutEmail (the DTO's own
    // "cleared" representation) is falsy and correctly rejected here exactly
    // like a missing one — no separate empty-string branch is needed.
    let paypalEmail: string | null = null;
    if (input.method === 'paypal') {
      const providerProfile = await prisma.providerProfile.findUnique({
        where: { userId },
        select: { paypalPayoutEmail: true }
      });
      if (!providerProfile?.paypalPayoutEmail) {
        throw new AppError('يجب إضافة بريد PayPal لاستلام الأرباح من إعدادات ملفك الشخصي قبل تقديم طلب سحب عبر PayPal', 400);
      }
      paypalEmail = providerProfile.paypalPayoutEmail;
    }

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
            where: { userId, status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
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
              // The IMMUTABLE destination snapshot — resolved once, above,
              // outside this transaction/retry loop. Always null for a
              // non-PayPal withdrawal.
              paypalEmail,
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

  /**
   * Marketer/affiliate withdrawal — same "single SERIALIZABLE transaction
   * covers the balance read, the outstanding-withdrawals read, and the
   * insert" invariant as createForProvider() above, and for the identical
   * reason: without it, two concurrent requests for the same affiliate
   * could each read the same not-yet-reserved outstanding sum and together
   * withdraw more than their real available commission balance.
   *
   * Available balance here is SUM(CommissionLog.amount) where status is
   * APPROVED for this affiliate — the same total the summary/dashboard
   * ("رصيد قابل للسحب") already shows — not an escrow-derived figure like
   * the provider wallet, since affiliates never hold project escrow.
   *
   * The bank destination (iban/accountHolderName/bankName) is never taken
   * from the request — it is snapshotted here from the affiliate's own
   * AffiliateProfile, exactly like createForProvider()'s PayPal-email
   * snapshot, so a later profile edit can never retroactively change where
   * an already-created withdrawal is paid.
   */
  async createForMarketer(userId: string, input: CreateMarketerWithdrawalInput) {
    const affiliate = await prisma.affiliateProfile.findUnique({
      where: { userId },
      select: { id: true, iban: true, bankName: true, accountHolderName: true, minimumPayoutAmount: true }
    });
    if (!affiliate) throw new AppError('ملف الوسيط التسويقي غير موجود', 404);
    // Fail closed for a user who is ALSO a provider: approve() cannot tell a
    // commission withdrawal from a provider-earnings withdrawal for such a
    // user without a per-row ledger discriminator (not in the schema), so it
    // would check the provider wallet — see ApprovalLedger above.
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { accountType: true, roles: true, activeRole: true }
    });
    if (owner && isProviderIdentity(owner)) {
      throw new AppError('سحب العمولات غير متاح حاليًا للحسابات التي تجمع بين دور الوسيط ودور مقدم الخدمة، يرجى التواصل مع الدعم', 409);
    }
    if (!affiliate.iban) {
      throw new AppError('يجب إضافة رقم الحساب البنكي (IBAN) من الملف الشخصي قبل تقديم طلب سحب', 400);
    }
    // P-LG-012 states a 300 withdrawal-minimum floor. This respects any
    // existing per-affiliate custom minimumPayoutAmount value (which may be
    // set higher than 300) while enforcing 300 as an absolute floor for
    // everyone — touches no historical AffiliateProfile data, only this
    // validation check.
    const effectiveMinimumPayout = Math.max(affiliate.minimumPayoutAmount, 300);
    if (input.amount < effectiveMinimumPayout) {
      throw new AppError(`الحد الأدنى لطلب السحب ${effectiveMinimumPayout} ريال`, 400);
    }

    const withdrawalId = randomUUID();
    const referenceId = deriveWithdrawalReferenceId(withdrawalId);

    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          const approvedCommissions = await tx.commissionLog.aggregate({
            where: { affiliateId: affiliate.id, status: CommissionStatus.APPROVED },
            _sum: { amount: true },
          });
          const availableBalance = approvedCommissions._sum.amount || 0;
          if (input.amount > availableBalance) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك المتاح (${availableBalance} ريال)`, 400);
          }
          const outstandingWithdrawals = await tx.withdrawal.aggregate({
            where: { userId, status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
            _sum: { amount: true },
          });
          const outstandingAmount = outstandingWithdrawals._sum.amount || 0;
          const withdrawable = availableBalance - outstandingAmount;
          if (input.amount > withdrawable) {
            throw new AppError(`المبلغ المطلوب يتجاوز رصيدك الصافي بعد طلبات السحب المعلقة (${withdrawable} ريال)`, 400);
          }
          return tx.withdrawal.create({
            data: {
              id: withdrawalId,
              referenceId,
              userId,
              amount: input.amount,
              currency: 'SAR',
              method: 'bank_transfer',
              accountName: affiliate.accountHolderName,
              iban: affiliate.iban,
              status: WithdrawalStatus.PENDING,
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isRetryableTransactionConflict(error) && attempt < MAX_SERIALIZATION_RETRIES) continue;
        throw error;
      }
    }
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
    // Release-blocker fix (admin withdrawal detail): the frontend used to
    // fabricate an "available balance" from a deterministic hash of the
    // withdrawal's own id — never real data. Compute the actual authoritative
    // balance for this withdrawal's ledger (same resolveApprovalLedger() and
    // same withdrawable-balance arithmetic approve() itself will use), so the
    // admin sees a real, non-invented figure instead of a fabricated one.
    const availableBalance = await this.getWithdrawableBalanceForDisplay(item.userId);
    return { ...item, availableBalance };
  }

  /**
   * Read-only display helper for get() above — deliberately NOT shared with
   * approve()'s own transactional balance check (which runs inside a
   * SERIALIZABLE transaction and is the actual authorization decision).
   * This duplicates the same arithmetic on a plain (non-transactional) read
   * purely to show an accurate number to an admin browsing the detail page;
   * it has no bearing on whether a withdrawal is actually approved.
   */
  private async getWithdrawableBalanceForDisplay(userId: string): Promise<number> {
    const ledger = await this.resolveApprovalLedger(userId);
    if (ledger.kind === 'AFFILIATE_COMMISSION') {
      const approvedCommissions = await prisma.commissionLog.aggregate({
        where: { affiliateId: ledger.affiliateId, status: CommissionStatus.APPROVED },
        _sum: { amount: true },
      });
      const alreadyWithdrawn = await prisma.withdrawal.aggregate({
        where: { userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
        _sum: { amount: true },
      });
      return (approvedCommissions._sum.amount || 0) - (alreadyWithdrawn._sum.amount || 0);
    }
    const wallet = await providerFinanceService.getWallet(userId);
    const alreadyWithdrawn = await prisma.withdrawal.aggregate({
      where: { userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
      _sum: { amount: true },
    });
    return wallet.summary.availableBalance - (alreadyWithdrawn._sum.amount || 0);
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
   * read the withdrawal table's {APPROVED,COMPLETED,REVERSED} aggregate for
   * that userId, and each is about to WRITE a row into that same set — a
   * genuine read/write dependency Postgres's serializable snapshot isolation
   * detects and aborts one side of, exactly like createForProvider()'s own
   * concurrent-create protection. The loser is retried here (bounded, via
   * the same isRetryableTransactionConflict() classifier as Batch 2A/
   * createForProvider() — not a weaker P2034-only check), and because the
   * retry re-runs this entire transaction body from scratch, it re-reads
   * the wallet balance and the withdrawn aggregate fresh, now seeing the
   * winner's committed APPROVED row — so a retry that would overspend fails
   * with the same clean AppError, not a raw technical conflict.
   *
   * Payout P3-A hardening: REVERSED is included in this aggregate for the
   * exact same reason as createForProvider()'s own equivalent fix above —
   * a REVERSED withdrawal's earnings were already paid out once and then
   * taken back by PayPal; they must remain reserved against being approved
   * a second time via some OTHER withdrawal for the same provider, not
   * freed the way a REJECTED withdrawal's never-paid earnings correctly
   * are.
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

    const ledger = await this.resolveApprovalLedger(item.userId);

    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          if (ledger.kind === 'AFFILIATE_COMMISSION') {
            // Marketer/affiliate commission withdrawal: the authoritative
            // balance is SUM(APPROVED CommissionLog.amount) for this
            // affiliate — the same source createForMarketer() validated
            // against — minus every already-approved/in-flight/paid/reversed
            // withdrawal of this user. Read via `tx` inside the same
            // SERIALIZABLE snapshot as the conditional transition below, so
            // two concurrent approvals of two different withdrawals for the
            // same marketer cannot together exceed the commission balance.
            // PENDING/REJECTED rows never consume balance here.
            const approvedCommissions = await tx.commissionLog.aggregate({
              where: { affiliateId: ledger.affiliateId, status: CommissionStatus.APPROVED },
              _sum: { amount: true },
            });
            const commissionBalance = approvedCommissions._sum.amount || 0;
            const alreadyWithdrawn = await tx.withdrawal.aggregate({
              where: { userId: item.userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
              _sum: { amount: true },
            });
            const withdrawableCommission = commissionBalance - (alreadyWithdrawn._sum.amount || 0);
            if (item.amount > withdrawableCommission) {
              throw new AppError(`رصيد عمولات الوسيط غير كافٍ لتنفيذ السحب (المتاح: ${withdrawableCommission} ${item.currency})`, 400);
            }
          } else {
          // Reads via `tx`, not the global `prisma` — the balance
          // eligibility check must be part of the SAME serializable
          // snapshot as the conditional status transition below, not a
          // read taken from outside the transaction.
          const wallet = await providerFinanceService.getWallet(item.userId, tx);
          const availableBalance = wallet.summary.availableBalance;
          const alreadyWithdrawn = await tx.withdrawal.aggregate({
            where: { userId: item.userId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.COMPLETED, WithdrawalStatus.REVERSED] } },
            _sum: { amount: true },
          });
          const withdrawnAmount = alreadyWithdrawn._sum.amount || 0;
          const withdrawableBalance = availableBalance - withdrawnAmount;
          if (item.amount > withdrawableBalance) {
            throw new AppError(`رصيد المزود غير كافٍ لتنفيذ السحب (المتاح: ${withdrawableBalance} $)`, 400);
          }
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

  /** See ApprovalLedger at the top of this file. */
  private async resolveApprovalLedger(userId: string): Promise<ApprovalLedger> {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { accountType: true, roles: true, activeRole: true, affiliateProfile: { select: { id: true } } }
    });
    if (owner?.affiliateProfile && !isProviderIdentity(owner)) {
      return { kind: 'AFFILIATE_COMMISSION', affiliateId: owner.affiliateProfile.id };
    }
    return { kind: 'PROVIDER_EARNINGS' };
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
