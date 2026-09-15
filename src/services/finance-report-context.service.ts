import {
  AccountType,
  ContractStatus,
  EscrowStatus,
  ProjectStageStatus,
  ProjectStatus,
  ProposalStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import type {
  FinanceReportAggregate,
  FinanceReportOmittedInput,
  FinanceReportTrendComparison,
  FinancialReportInsightsContext,
} from '../modules/ai-engine';

export interface FinanceReportFacts {
  role: 'client' | 'provider';
  accountType: AccountType;
  currency: 'SAR';
  period: {
    generatedAt: string;
    monthStart: string;
    currentMonthStart: string;
    nextMonthStart: string;
    previousMonthStart: string;
  };
  aggregates: FinanceReportAggregate[];
  trendComparisons: FinanceReportTrendComparison[];
  omittedInputs: FinanceReportOmittedInput[];
  dataQualityNotes: string[];
}

export interface FinanceReportContextBuildResult {
  context: FinancialReportInsightsContext;
  facts: FinanceReportFacts;
}

const toSafeCents = (amount: number, fieldName: string): number => {
  if (!Number.isFinite(amount)) {
    throw new AppError(`${fieldName} must be a finite monetary value.`, 400);
  }

  const scaled = amount * 100;
  if (!Number.isFinite(scaled)) {
    throw new AppError(`${fieldName} is too large for safe cents conversion.`, 400);
  }

  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents)) {
    throw new AppError(`${fieldName} is not safely representable in cents.`, 400);
  }

  return cents;
};

const fromCents = (amountInCents: number): number => amountInCents / 100;

const normalizeMoney = (value: unknown, fieldName: string): number => {
  return fromCents(toSafeCents(Number(value ?? 0), fieldName));
};

const normalizeRatingAverage = (
  value: unknown,
  fieldName: string
): number | null => {
  if (value === null || value === undefined) return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 5) {
    throw new AppError(`${fieldName} must be a finite rating from 0 to 5.`, 400);
  }

  return Math.round(numeric * 100) / 100;
};

const subtractMoney = (
  amount: unknown,
  released: unknown,
  fieldName: string
): number => {
  const amountCents = toSafeCents(Number(amount ?? 0), `${fieldName} amount`);
  const releasedCents = toSafeCents(Number(released ?? 0), `${fieldName} released`);
  const heldCents = Math.max(0, amountCents - releasedCents);

  if (!Number.isSafeInteger(heldCents)) {
    throw new AppError(`${fieldName} held amount is not safely representable.`, 400);
  }

  return fromCents(heldCents);
};

const normalizeCount = (value: number, fieldName: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(`${fieldName} must be a non-negative safe integer.`, 400);
  }

  return value;
};

const addCountAggregate = (
  aggregates: FinanceReportAggregate[],
  key: string,
  label: string,
  value: number,
  source: string
): void => {
  aggregates.push({
    key,
    label,
    value: normalizeCount(value, label),
    unit: 'count',
    quality: 'verified',
    source,
  });
};

const addMoneyAggregate = (
  aggregates: FinanceReportAggregate[],
  key: string,
  label: string,
  value: unknown,
  source: string
): void => {
  aggregates.push({
    key,
    label,
    value: normalizeMoney(value, label),
    unit: 'SAR',
    quality: 'verified',
    source,
  });
};

const addRatingAggregates = (
  aggregates: FinanceReportAggregate[],
  keyPrefix: string,
  labelPrefix: string,
  count: number,
  average: number | null,
  source: string
): void => {
  addCountAggregate(
    aggregates,
    `${keyPrefix}_rating_count`,
    `${labelPrefix} rating count`,
    count,
    source
  );

  if (average !== null) {
    aggregates.push({
      key: `${keyPrefix}_average_rating`,
      label: `${labelPrefix} average rating`,
      value: average,
      unit: 'rating',
      quality: 'verified',
      source,
    });
  }
};

interface MonthBounds {
  previousMonthStart: Date;
  currentMonthStart: Date;
  nextMonthStart: Date;
}

const monthBoundsFor = (now: Date): MonthBounds => {
  return {
    previousMonthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    currentMonthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    nextMonthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
};

const safeAddCents = (
  currentTotalCents: number,
  nextCents: number,
  fieldName: string
): number => {
  const totalCents = currentTotalCents + nextCents;
  if (!Number.isSafeInteger(totalCents)) {
    throw new AppError(`${fieldName} total is not safely representable.`, 400);
  }

  return totalCents;
};

const sumMoneyRows = (
  rows: Array<{ amount: number }>,
  fieldName: string,
  options: { absolute?: boolean } = {}
): { value: number; sampleSize: number } => {
  let totalCents = 0;

  for (const row of rows) {
    const cents = toSafeCents(Number(row.amount), `${fieldName} row amount`);
    totalCents = safeAddCents(
      totalCents,
      options.absolute ? Math.abs(cents) : cents,
      fieldName
    );
  }

  return {
    value: fromCents(totalCents),
    sampleSize: normalizeCount(rows.length, `${fieldName} sample size`),
  };
};

const createTrendComparison = (
  key: string,
  label: string,
  unit: 'count' | 'SAR' | 'rating',
  source: string,
  bounds: MonthBounds,
  current: { value: number | null; sampleSize: number; dataAvailable: boolean },
  previous: { value: number | null; sampleSize: number; dataAvailable: boolean }
): FinanceReportTrendComparison => {
  return {
    key,
    label,
    unit,
    quality: 'verified',
    source,
    currentPeriod: {
      start: bounds.currentMonthStart.toISOString(),
      end: bounds.nextMonthStart.toISOString(),
      value: current.value,
      sampleSize: normalizeCount(current.sampleSize, `${label} current sample size`),
      dataAvailable: current.dataAvailable,
    },
    previousPeriod: {
      start: bounds.previousMonthStart.toISOString(),
      end: bounds.currentMonthStart.toISOString(),
      value: previous.value,
      sampleSize: normalizeCount(previous.sampleSize, `${label} previous sample size`),
      dataAvailable: previous.dataAvailable,
    },
  };
};

const moneyTrendPeriod = (
  rows: Array<{ amount: number }>,
  fieldName: string,
  options: { absolute?: boolean } = {}
) => {
  const summed = sumMoneyRows(rows, fieldName, options);
  return {
    value: summed.value,
    sampleSize: summed.sampleSize,
    dataAvailable: true,
  };
};

const countTrendPeriod = (count: number, fieldName: string) => {
  return {
    value: normalizeCount(count, fieldName),
    sampleSize: normalizeCount(count, `${fieldName} sample size`),
    dataAvailable: true,
  };
};

const ratingTrendPeriod = (
  count: number,
  average: number | null,
  fieldName: string
) => {
  const sampleSize = normalizeCount(count, `${fieldName} sample size`);
  return {
    value: sampleSize > 0 ? average : null,
    sampleSize,
    dataAvailable: sampleSize > 0 && average !== null,
  };
};

const commonOmittedInputs = (): FinanceReportOmittedInput[] => [
  {
    name: 'dashboard.summary.aiRating',
    quality: 'placeholder',
    reason: 'Current dashboard stats return placeholder zero AI ratings.',
  },
  {
    name: 'dashboard.summary.humanRating',
    quality: 'placeholder',
    reason: 'Current dashboard stats return placeholder zero human ratings.',
  },
  {
    name: 'project/proposal/user names and descriptions',
    quality: 'unsafe_not_suitable',
    reason: 'Aggregate-only finance insights do not require names or free text.',
  },
  {
    name: 'wallet transaction descriptions, metadata, and payment references',
    quality: 'unsafe_not_suitable',
    reason: 'These may contain payment identifiers or user-entered text.',
  },
];

const roleFromAccountType = (accountType: AccountType): 'client' | 'provider' => {
  if (
    accountType === AccountType.CLIENT_COMPANY ||
    accountType === AccountType.CLIENT_INDIVIDUAL
  ) {
    return 'client';
  }

  if (
    accountType === AccountType.PROVIDER_COMPANY ||
    accountType === AccountType.PROVIDER_INDIVIDUAL
  ) {
    return 'provider';
  }

  throw new AppError('Financial report insights are not available for this account type.', 501);
};

export class FinanceReportContextService {
  async build(
    userId: string,
    accountType: AccountType,
    now: Date = new Date()
  ): Promise<FinanceReportContextBuildResult> {
    const role = roleFromAccountType(accountType);

    return role === 'client'
      ? this.buildClientContext(userId, accountType, now)
      : this.buildProviderContext(userId, accountType, now);
  }

  private async buildClientContext(
    userId: string,
    accountType: AccountType,
    now: Date
  ): Promise<FinanceReportContextBuildResult> {
    const monthBounds = monthBoundsFor(now);
    const { previousMonthStart, currentMonthStart, nextMonthStart } = monthBounds;
    const [
      user,
      activeProjectsCount,
      completedProjectsCount,
      openProjectsCount,
      newOffersCount,
      activeContracts,
      completedContracts,
      heldEscrows,
      allEscrows,
      deposits,
      monthDeposits,
      escrowLocks,
      orderPayments,
      clientFinalRatings,
      clientStageRatings,
      currentFinalRatings,
      previousFinalRatings,
      currentEscrowFundings,
      previousEscrowFundings,
      currentOrderPayments,
      previousOrderPayments,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { walletBalance: true },
      }),
      prisma.project.count({
        where: { clientId: userId, status: ProjectStatus.IN_PROGRESS },
      }),
      prisma.project.count({
        where: { clientId: userId, status: ProjectStatus.COMPLETED },
      }),
      prisma.project.count({
        where: { clientId: userId, status: ProjectStatus.OPEN },
      }),
      prisma.proposal.count({
        where: { project: { clientId: userId, status: ProjectStatus.OPEN } },
      }),
      prisma.contract.aggregate({
        where: { clientId: userId, status: ContractStatus.ACTIVE },
        _count: { _all: true },
        _sum: { price: true },
      }),
      prisma.contract.aggregate({
        where: { clientId: userId, status: ContractStatus.COMPLETED },
        _count: { _all: true },
        _sum: { price: true },
      }),
      prisma.escrow.aggregate({
        where: { project: { clientId: userId }, status: EscrowStatus.HELD },
        _count: { _all: true },
        _sum: { amount: true, releasedAmount: true },
      }),
      prisma.escrow.aggregate({
        where: { project: { clientId: userId } },
        _count: { _all: true },
        _sum: { amount: true, releasedAmount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { userId, type: 'DEPOSIT', status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: {
          userId,
          type: 'DEPOSIT',
          status: 'COMPLETED',
          createdAt: { gte: currentMonthStart, lt: nextMonthStart },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { userId, type: 'ESCROW_LOCK', status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { userId, type: 'ORDER_PAYMENT', status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.review.aggregate({
        where: {
          clientId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
          OR: [
            { project: { clientId: userId } },
            { clientRequest: { clientProfile: { userId } } },
          ],
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          clientId: userId,
          reviewerRole: 'CLIENT',
          stageId: { not: null },
          stage: { contract: { clientId: userId } },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          clientId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
          createdAt: { gte: currentMonthStart, lt: nextMonthStart },
          OR: [
            { project: { clientId: userId } },
            { clientRequest: { clientProfile: { userId } } },
          ],
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          clientId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
          createdAt: { gte: previousMonthStart, lt: currentMonthStart },
          OR: [
            { project: { clientId: userId } },
            { clientRequest: { clientProfile: { userId } } },
          ],
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.escrow.findMany({
        where: {
          project: { clientId: userId },
          fundedAt: { gte: currentMonthStart, lt: nextMonthStart },
        },
        select: { amount: true },
      }),
      prisma.escrow.findMany({
        where: {
          project: { clientId: userId },
          fundedAt: { gte: previousMonthStart, lt: currentMonthStart },
        },
        select: { amount: true },
      }),
      prisma.walletTransaction.findMany({
        where: {
          userId,
          type: 'ORDER_PAYMENT',
          status: 'COMPLETED',
          createdAt: { gte: currentMonthStart, lt: nextMonthStart },
        },
        select: { amount: true },
      }),
      prisma.walletTransaction.findMany({
        where: {
          userId,
          type: 'ORDER_PAYMENT',
          status: 'COMPLETED',
          createdAt: { gte: previousMonthStart, lt: currentMonthStart },
        },
        select: { amount: true },
      }),
    ]);

    if (!user) {
      throw new AppError('User was not found for financial report insights.', 404);
    }

    const aggregates: FinanceReportAggregate[] = [];
    addMoneyAggregate(
      aggregates,
      'wallet_balance',
      'Current wallet balance',
      user.walletBalance,
      'users.walletBalance'
    );
    addCountAggregate(
      aggregates,
      'active_projects_count',
      'Active projects count',
      activeProjectsCount,
      'projects.status=IN_PROGRESS'
    );
    addCountAggregate(
      aggregates,
      'completed_projects_count',
      'Completed projects count',
      completedProjectsCount,
      'projects.status=COMPLETED'
    );
    addCountAggregate(
      aggregates,
      'open_projects_count',
      'Open projects count',
      openProjectsCount,
      'projects.status=OPEN'
    );
    addCountAggregate(
      aggregates,
      'new_offers_count',
      'New offers count',
      newOffersCount,
      'proposals on open client projects'
    );
    addCountAggregate(
      aggregates,
      'active_contracts_count',
      'Active contracts count',
      activeContracts._count._all,
      'contracts.status=ACTIVE'
    );
    addMoneyAggregate(
      aggregates,
      'active_contract_value',
      'Active contract value',
      activeContracts._sum.price,
      'contracts.price where status=ACTIVE'
    );
    addCountAggregate(
      aggregates,
      'completed_contracts_count',
      'Completed contracts count',
      completedContracts._count._all,
      'contracts.status=COMPLETED'
    );
    addMoneyAggregate(
      aggregates,
      'completed_contract_value',
      'Completed contract value',
      completedContracts._sum.price,
      'contracts.price where status=COMPLETED'
    );
    addCountAggregate(
      aggregates,
      'held_escrows_count',
      'Held escrows count',
      heldEscrows._count._all,
      'escrows.status=HELD'
    );
    addMoneyAggregate(
      aggregates,
      'held_escrow_balance',
      'Held escrow balance',
      subtractMoney(
        heldEscrows._sum.amount,
        heldEscrows._sum.releasedAmount,
        'Held escrow balance'
      ),
      'escrows.amount minus escrows.releasedAmount where status=HELD'
    );
    addCountAggregate(
      aggregates,
      'all_escrows_count',
      'All escrows count',
      allEscrows._count._all,
      'escrows linked to client projects'
    );
    addMoneyAggregate(
      aggregates,
      'total_released_from_escrow',
      'Total released from escrow',
      allEscrows._sum.releasedAmount,
      'escrows.releasedAmount'
    );
    addCountAggregate(
      aggregates,
      'completed_deposits_count',
      'Completed deposits count',
      deposits._count._all,
      'wallet_transactions.type=DEPOSIT'
    );
    addMoneyAggregate(
      aggregates,
      'completed_deposits_total',
      'Completed deposits total',
      deposits._sum.amount,
      'wallet_transactions.amount where type=DEPOSIT'
    );
    addMoneyAggregate(
      aggregates,
      'month_deposits_total',
      'Current month deposits total',
      monthDeposits._sum.amount,
      'wallet_transactions.amount where type=DEPOSIT and created this month'
    );
    addMoneyAggregate(
      aggregates,
      'escrow_locks_total',
      'Escrow locks total',
      escrowLocks._sum.amount,
      'wallet_transactions.amount where type=ESCROW_LOCK'
    );
    addMoneyAggregate(
      aggregates,
      'order_payments_total',
      'Order payments total',
      Math.abs(normalizeMoney(orderPayments._sum.amount, 'Order payments total')),
      'absolute wallet_transactions.amount where type=ORDER_PAYMENT'
    );

    const clientFinalRatingAverage = normalizeRatingAverage(
      clientFinalRatings._avg.rating,
      'Client final provider average rating'
    );
    const clientStageRatingAverage = normalizeRatingAverage(
      clientStageRatings._avg.rating,
      'Client stage average rating'
    );
    const currentFinalRatingAverage = normalizeRatingAverage(
      currentFinalRatings._avg.rating,
      'Current month client final provider average rating'
    );
    const previousFinalRatingAverage = normalizeRatingAverage(
      previousFinalRatings._avg.rating,
      'Previous month client final provider average rating'
    );

    addRatingAggregates(
      aggregates,
      'quality_client_final_provider',
      'Client-issued final provider quality',
      clientFinalRatings._count._all,
      clientFinalRatingAverage,
      'reviews.rating where clientId=userId, reviewerRole=CLIENT, stageId=null, and owned project/request'
    );
    addRatingAggregates(
      aggregates,
      'quality_client_stage',
      'Client-issued stage quality',
      clientStageRatings._count._all,
      clientStageRatingAverage,
      'reviews.rating where clientId=userId, reviewerRole=CLIENT, stageId is present, and stage contract belongs to client'
    );

    const trendComparisons: FinanceReportTrendComparison[] = [
      createTrendComparison(
        'client_escrow_funding_total',
        'Client escrow funding total',
        'SAR',
        'escrows.amount by fundedAt for client projects',
        monthBounds,
        moneyTrendPeriod(currentEscrowFundings, 'Current month client escrow funding'),
        moneyTrendPeriod(previousEscrowFundings, 'Previous month client escrow funding')
      ),
      createTrendComparison(
        'client_escrow_funding_count',
        'Client escrow funding count',
        'count',
        'escrows fundedAt for client projects',
        monthBounds,
        countTrendPeriod(currentEscrowFundings.length, 'Current month client escrow funding count'),
        countTrendPeriod(previousEscrowFundings.length, 'Previous month client escrow funding count')
      ),
      createTrendComparison(
        'client_order_payment_total',
        'Client marketplace order payment total',
        'SAR',
        'absolute wallet_transactions.amount where type=ORDER_PAYMENT and status=COMPLETED',
        monthBounds,
        moneyTrendPeriod(
          currentOrderPayments,
          'Current month client marketplace order payment',
          { absolute: true }
        ),
        moneyTrendPeriod(
          previousOrderPayments,
          'Previous month client marketplace order payment',
          { absolute: true }
        )
      ),
      createTrendComparison(
        'client_order_payment_count',
        'Client marketplace order payment count',
        'count',
        'wallet_transactions where type=ORDER_PAYMENT and status=COMPLETED',
        monthBounds,
        countTrendPeriod(currentOrderPayments.length, 'Current month client marketplace order payment count'),
        countTrendPeriod(previousOrderPayments.length, 'Previous month client marketplace order payment count')
      ),
      createTrendComparison(
        'client_final_provider_average_rating',
        'Client-issued final provider average rating',
        'rating',
        'reviews.rating where clientId=userId, reviewerRole=CLIENT, stageId=null, and owned project/request',
        monthBounds,
        ratingTrendPeriod(
          currentFinalRatings._count._all,
          currentFinalRatingAverage,
          'Current month client final provider average rating'
        ),
        ratingTrendPeriod(
          previousFinalRatings._count._all,
          previousFinalRatingAverage,
          'Previous month client final provider average rating'
        )
      ),
      createTrendComparison(
        'client_final_provider_rating_count',
        'Client-issued final provider rating count',
        'count',
        'reviews.rating where clientId=userId, reviewerRole=CLIENT, stageId=null, and owned project/request',
        monthBounds,
        countTrendPeriod(currentFinalRatings._count._all, 'Current month client final provider rating count'),
        countTrendPeriod(previousFinalRatings._count._all, 'Previous month client final provider rating count')
      ),
    ];

    return this.createResult({
      role: 'client',
      accountType,
      now,
      aggregates,
      trendComparisons,
      omittedInputs: [
        ...commonOmittedInputs(),
        {
          name: 'dashboard.summary.totalSpent',
          quality: 'approximate',
          reason:
            'Dashboard totalSpent is budget-derived, so contract and ledger aggregates are used instead.',
        },
      ],
      dataQualityNotes: [
        'Invoice, tax, wallet, escrow, and contract values are backend facts; the model may interpret but not recalculate them.',
        'Budget-proxy dashboard spending is omitted from model context.',
        'Wallet deposits are funding activity, not spending, and must not be described as spending.',
        'Trend comparisons use UTC calendar months and like-for-like metrics only.',
      ],
      monthBounds,
    });
  }

  private async buildProviderContext(
    userId: string,
    accountType: AccountType,
    now: Date
  ): Promise<FinanceReportContextBuildResult> {
    const monthBounds = monthBoundsFor(now);
    const { previousMonthStart, currentMonthStart, nextMonthStart } = monthBounds;
    const [
      activeProjectsCount,
      completedProjectsCount,
      pendingOffersCount,
      acceptedOffersCount,
      activeContracts,
      completedContracts,
      allEscrows,
      heldEscrows,
      currentReleasedStages,
      previousReleasedStages,
      providerFinalRatings,
      providerStageRatings,
      currentFinalRatings,
      previousFinalRatings,
      pendingWithdrawals,
      approvedWithdrawals,
    ] = await Promise.all([
      prisma.project.count({
        where: { providerId: userId, status: ProjectStatus.IN_PROGRESS },
      }),
      prisma.project.count({
        where: { providerId: userId, status: ProjectStatus.COMPLETED },
      }),
      prisma.proposal.count({
        where: { providerId: userId, status: ProposalStatus.PENDING },
      }),
      prisma.proposal.count({
        where: { providerId: userId, status: ProposalStatus.ACCEPTED },
      }),
      prisma.contract.aggregate({
        where: { providerId: userId, status: ContractStatus.ACTIVE },
        _count: { _all: true },
        _sum: { price: true },
      }),
      prisma.contract.aggregate({
        where: { providerId: userId, status: ContractStatus.COMPLETED },
        _count: { _all: true },
        _sum: { price: true },
      }),
      prisma.escrow.aggregate({
        where: { project: { providerId: userId } },
        _count: { _all: true },
        _sum: { amount: true, releasedAmount: true },
      }),
      prisma.escrow.aggregate({
        where: { project: { providerId: userId }, status: EscrowStatus.HELD },
        _count: { _all: true },
        _sum: { amount: true, releasedAmount: true },
      }),
      prisma.projectStage.findMany({
        where: {
          status: ProjectStageStatus.APPROVED,
          approvedAt: { gte: currentMonthStart, lt: nextMonthStart },
          contract: { providerId: userId },
        },
        select: { amount: true },
      }),
      prisma.projectStage.findMany({
        where: {
          status: ProjectStageStatus.APPROVED,
          approvedAt: { gte: previousMonthStart, lt: currentMonthStart },
          contract: { providerId: userId },
        },
        select: { amount: true },
      }),
      prisma.review.aggregate({
        where: {
          providerId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          providerId: userId,
          reviewerRole: 'CLIENT',
          stageId: { not: null },
          stage: { contract: { providerId: userId } },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          providerId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
          createdAt: { gte: currentMonthStart, lt: nextMonthStart },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.review.aggregate({
        where: {
          providerId: userId,
          reviewerRole: 'CLIENT',
          stageId: null,
          createdAt: { gte: previousMonthStart, lt: currentMonthStart },
        },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      prisma.withdrawal.aggregate({
        where: { userId, status: WithdrawalStatus.PENDING },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.withdrawal.aggregate({
        where: {
          userId,
          status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.COMPLETED] },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const currentReleasedStagePeriod = moneyTrendPeriod(
      currentReleasedStages,
      'Current month provider approved-stage release'
    );
    const previousReleasedStagePeriod = moneyTrendPeriod(
      previousReleasedStages,
      'Previous month provider approved-stage release'
    );

    const providerFinalRatingAverage = normalizeRatingAverage(
      providerFinalRatings._avg.rating,
      'Provider received final average rating'
    );
    const providerStageRatingAverage = normalizeRatingAverage(
      providerStageRatings._avg.rating,
      'Provider received stage average rating'
    );
    const currentFinalRatingAverage = normalizeRatingAverage(
      currentFinalRatings._avg.rating,
      'Current month provider received final average rating'
    );
    const previousFinalRatingAverage = normalizeRatingAverage(
      previousFinalRatings._avg.rating,
      'Previous month provider received final average rating'
    );

    const aggregates: FinanceReportAggregate[] = [];
    addCountAggregate(
      aggregates,
      'active_projects_count',
      'Active projects count',
      activeProjectsCount,
      'projects.status=IN_PROGRESS'
    );
    addCountAggregate(
      aggregates,
      'completed_projects_count',
      'Completed projects count',
      completedProjectsCount,
      'projects.status=COMPLETED'
    );
    addCountAggregate(
      aggregates,
      'pending_offers_count',
      'Pending offers count',
      pendingOffersCount,
      'proposals.status=PENDING'
    );
    addCountAggregate(
      aggregates,
      'accepted_offers_count',
      'Accepted offers count',
      acceptedOffersCount,
      'proposals.status=ACCEPTED'
    );
    addCountAggregate(
      aggregates,
      'active_contracts_count',
      'Active contracts count',
      activeContracts._count._all,
      'contracts.status=ACTIVE'
    );
    addMoneyAggregate(
      aggregates,
      'active_contract_value',
      'Active contract value',
      activeContracts._sum.price,
      'contracts.price where status=ACTIVE'
    );
    addCountAggregate(
      aggregates,
      'completed_contracts_count',
      'Completed contracts count',
      completedContracts._count._all,
      'contracts.status=COMPLETED'
    );
    addMoneyAggregate(
      aggregates,
      'completed_contract_value',
      'Completed contract value',
      completedContracts._sum.price,
      'contracts.price where status=COMPLETED'
    );
    addCountAggregate(
      aggregates,
      'all_escrows_count',
      'All escrows count',
      allEscrows._count._all,
      'escrows linked to provider projects'
    );
    addMoneyAggregate(
      aggregates,
      'total_released_from_escrow',
      'Total released from escrow',
      allEscrows._sum.releasedAmount,
      'escrows.releasedAmount'
    );
    addCountAggregate(
      aggregates,
      'held_escrows_count',
      'Held escrows count',
      heldEscrows._count._all,
      'escrows.status=HELD'
    );
    addMoneyAggregate(
      aggregates,
      'held_escrow_balance',
      'Held escrow balance',
      subtractMoney(
        heldEscrows._sum.amount,
        heldEscrows._sum.releasedAmount,
        'Held escrow balance'
      ),
      'escrows.amount minus escrows.releasedAmount where status=HELD'
    );
    addMoneyAggregate(
      aggregates,
      'month_released_stage_total',
      'Current month released stage total',
      currentReleasedStagePeriod.value,
      'project_stages.amount where status=APPROVED and approvedAt is in current UTC month'
    );
    addCountAggregate(
      aggregates,
      'month_released_stage_count',
      'Current month released stage count',
      currentReleasedStages.length,
      'project_stages where status=APPROVED and approvedAt is in current UTC month'
    );
    addCountAggregate(
      aggregates,
      'pending_withdrawals_count',
      'Pending withdrawals count',
      pendingWithdrawals._count._all,
      'withdrawals.status=PENDING'
    );
    addMoneyAggregate(
      aggregates,
      'pending_withdrawals_total',
      'Pending withdrawals total',
      pendingWithdrawals._sum.amount,
      'withdrawals.amount where status=PENDING'
    );
    addMoneyAggregate(
      aggregates,
      'approved_withdrawals_total',
      'Approved withdrawals total',
      approvedWithdrawals._sum.amount,
      'withdrawals.amount where status=APPROVED or COMPLETED'
    );

    addRatingAggregates(
      aggregates,
      'quality_provider_received_final',
      'Provider received final client quality',
      providerFinalRatings._count._all,
      providerFinalRatingAverage,
      'reviews.rating where providerId=userId, reviewerRole=CLIENT, stageId=null'
    );
    addRatingAggregates(
      aggregates,
      'quality_provider_received_stage',
      'Provider received stage client quality',
      providerStageRatings._count._all,
      providerStageRatingAverage,
      'reviews.rating where providerId=userId, reviewerRole=CLIENT, stageId is present, and stage contract belongs to provider'
    );

    const trendComparisons: FinanceReportTrendComparison[] = [
      createTrendComparison(
        'provider_approved_stage_release_total',
        'Provider approved-stage release total',
        'SAR',
        'project_stages.amount where status=APPROVED and approvedAt is in UTC month',
        monthBounds,
        currentReleasedStagePeriod,
        previousReleasedStagePeriod
      ),
      createTrendComparison(
        'provider_approved_stage_release_count',
        'Provider approved-stage release count',
        'count',
        'project_stages where status=APPROVED and approvedAt is in UTC month',
        monthBounds,
        countTrendPeriod(
          currentReleasedStages.length,
          'Current month provider approved-stage release count'
        ),
        countTrendPeriod(
          previousReleasedStages.length,
          'Previous month provider approved-stage release count'
        )
      ),
      createTrendComparison(
        'provider_received_final_average_rating',
        'Provider received final client average rating',
        'rating',
        'reviews.rating where providerId=userId, reviewerRole=CLIENT, stageId=null',
        monthBounds,
        ratingTrendPeriod(
          currentFinalRatings._count._all,
          currentFinalRatingAverage,
          'Current month provider received final average rating'
        ),
        ratingTrendPeriod(
          previousFinalRatings._count._all,
          previousFinalRatingAverage,
          'Previous month provider received final average rating'
        )
      ),
      createTrendComparison(
        'provider_received_final_rating_count',
        'Provider received final client rating count',
        'count',
        'reviews.rating where providerId=userId, reviewerRole=CLIENT, stageId=null',
        monthBounds,
        countTrendPeriod(
          currentFinalRatings._count._all,
          'Current month provider received final rating count'
        ),
        countTrendPeriod(
          previousFinalRatings._count._all,
          'Previous month provider received final rating count'
        )
      ),
    ];

    return this.createResult({
      role: 'provider',
      accountType,
      now,
      aggregates,
      trendComparisons,
      omittedInputs: [
        ...commonOmittedInputs(),
        {
          name: 'dashboard.aiMatchingProjects.aiMatchScore',
          quality: 'placeholder',
          reason: 'Provider dashboard matching score is currently a placeholder zero.',
        },
        {
          name: 'dashboard.summary.totalEscrowAmount',
          quality: 'placeholder',
          reason:
            'Provider dashboard currently returns placeholder escrow total; verified escrow aggregates are used instead.',
        },
        {
          name: 'dashboard.summary.monthlyEarnings',
          quality: 'approximate',
          reason:
            'Provider dashboard monthly earnings uses completed project budget proxies; stage release aggregates are used instead.',
        },
      ],
      dataQualityNotes: [
        'Provider report context uses aggregate contract, escrow, stage release, proposal, and withdrawal facts.',
        'Dashboard placeholder financial values are omitted from model context.',
        'Provider earnings trends use approved-stage release records, not project budget placeholders.',
        'Trend comparisons use UTC calendar months and like-for-like metrics only.',
      ],
      monthBounds,
    });
  }

  private createResult(input: {
    role: 'client' | 'provider';
    accountType: AccountType;
    now: Date;
    aggregates: FinanceReportAggregate[];
    trendComparisons: FinanceReportTrendComparison[];
    omittedInputs: FinanceReportOmittedInput[];
    dataQualityNotes: string[];
    monthBounds: MonthBounds;
  }): FinanceReportContextBuildResult {
    const generatedAt = input.now.toISOString();
    const previousMonthStart = input.monthBounds.previousMonthStart.toISOString();
    const currentMonthStart = input.monthBounds.currentMonthStart.toISOString();
    const nextMonthStart = input.monthBounds.nextMonthStart.toISOString();
    const monthStart = currentMonthStart;
    const context: FinancialReportInsightsContext = {
      role: input.role,
      accountType: input.accountType,
      currency: 'SAR',
      period: {
        generatedAt,
        monthStart,
        currentMonthStart,
        nextMonthStart,
        previousMonthStart,
      },
      aggregates: input.aggregates,
      trendComparisons: input.trendComparisons,
      omittedInputs: input.omittedInputs,
      dataQualityNotes: input.dataQualityNotes,
    };

    return {
      context,
      facts: {
        role: input.role,
        accountType: input.accountType,
        currency: 'SAR',
        period: {
          generatedAt,
          monthStart,
          currentMonthStart,
          nextMonthStart,
          previousMonthStart,
        },
        aggregates: input.aggregates,
        trendComparisons: input.trendComparisons,
        omittedInputs: input.omittedInputs,
        dataQualityNotes: input.dataQualityNotes,
      },
    };
  }
}

export const financeReportContextService = new FinanceReportContextService();
