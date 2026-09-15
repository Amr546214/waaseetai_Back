import { clientFinanceService } from './client-finance.service';
import { AppError } from '../utils/app-error';
import type { InvoiceConsistencyAnalysisContext } from '../modules/ai-engine';

const STAGE_TITLE_LENGTH = 160;

export interface InvoiceConsistencyFacts {
  invoice: {
    id: string;
    sourceId: string;
    contractId: string;
    projectId: string;
    stageId: string;
    status: string;
    issuedAt: string;
    paymentDate: string | null;
  };
  amounts: {
    subtotal: number;
    tax: number;
    taxRatePercent: number;
    total: number;
    currency: 'SAR';
  };
  verification: {
    score: number;
    taxDocumentAvailable: boolean;
    commercialRegistrationAvailable: boolean;
  };
  sourceState: {
    stageStatus: string;
    deliveryStatus: string;
  };
  deterministicChecks: {
    amountsSafelyRepresented: boolean;
    subtotalPlusTaxMatchesTotal: boolean;
    paidStatusMatchesApprovedSource: boolean;
  };
}

export interface InvoiceConsistencyContextBuildResult {
  context: InvoiceConsistencyAnalysisContext;
  facts: InvoiceConsistencyFacts;
}

const capText = (value: string | null | undefined, maxLength: number): string => {
  const trimmed = (value ?? '').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

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

const normalizeMoney = (
  value: unknown,
  fieldName: string,
  options: { allowZero?: boolean } = {}
): number => {
  const normalized = fromCents(toSafeCents(Number(value), fieldName));
  if (normalized < 0 || (!options.allowZero && normalized <= 0)) {
    throw new AppError(
      `${fieldName} must be ${options.allowZero ? 'non-negative' : 'greater than zero'}.`,
      400
    );
  }

  return normalized;
};

const normalizePercent = (value: unknown, fieldName: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new AppError(`${fieldName} must be a finite percentage from 0 to 100.`, 400);
  }

  return Math.round(numeric * 10) / 10;
};

const normalizeScore = (value: unknown, fieldName: string): number => {
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0 ||
    numeric > 100
  ) {
    throw new AppError(`${fieldName} must be an integer score from 0 to 100.`, 400);
  }

  return numeric;
};

const normalizeDate = (
  value: string | Date | null | undefined,
  fieldName: string
): string | null => {
  if (value === null || value === undefined) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(`${fieldName} must be a valid date.`, 400);
  }

  return date.toISOString();
};

export class InvoiceAnalysisContextService {
  async build(
    clientId: string,
    deliveryId: string
  ): Promise<InvoiceConsistencyContextBuildResult> {
    const { invoice, sourceState } =
      await clientFinanceService.getInvoiceAnalysisSource(clientId, deliveryId);

    const subtotalCents = toSafeCents(
      normalizeMoney(invoice.subtotal, 'Invoice subtotal', { allowZero: true }),
      'Invoice subtotal'
    );
    const taxCents = toSafeCents(
      normalizeMoney(invoice.tax, 'Invoice tax', { allowZero: true }),
      'Invoice tax'
    );
    const totalCents = toSafeCents(
      normalizeMoney(invoice.total, 'Invoice total'),
      'Invoice total'
    );
    const issuedAt = normalizeDate(invoice.date, 'Invoice issue date');
    if (!issuedAt) {
      throw new AppError('Invoice issue date is required.', 400);
    }

    const paymentDate = normalizeDate(invoice.paymentDate, 'Invoice payment date');
    const taxRatePercent = normalizePercent(invoice.taxRate, 'Invoice tax rate');
    const verificationScore = normalizeScore(
      invoice.verificationScore,
      'Invoice verification score'
    );
    const paidSourceApproved =
      sourceState.stageStatus === 'APPROVED' &&
      sourceState.deliveryStatus === 'APPROVED';
    const paidStatusMatchesApprovedSource =
      invoice.status === 'paid'
        ? paidSourceApproved
        : !paidSourceApproved;

    const amounts = {
      subtotal: fromCents(subtotalCents),
      tax: fromCents(taxCents),
      taxRatePercent,
      total: fromCents(totalCents),
      currency: 'SAR' as const,
    };
    const verification = {
      score: verificationScore,
      taxDocumentAvailable: Boolean(invoice.taxDocumentAvailable),
      commercialRegistrationAvailable: Boolean(
        invoice.commercialRegistrationAvailable
      ),
    };
    const deterministicChecks = {
      amountsSafelyRepresented: true,
      subtotalPlusTaxMatchesTotal: subtotalCents + taxCents === totalCents,
      paidStatusMatchesApprovedSource,
    };

    const facts: InvoiceConsistencyFacts = {
      invoice: {
        id: invoice.id,
        sourceId: invoice.sourceId,
        contractId: invoice.contractId,
        projectId: invoice.projectId,
        stageId: invoice.stageId,
        status: invoice.status,
        issuedAt,
        paymentDate,
      },
      amounts,
      verification,
      sourceState,
      deterministicChecks,
    };

    return {
      facts,
      context: {
        invoice: {
          status: invoice.status,
          stageTitle: capText(invoice.stageTitle, STAGE_TITLE_LENGTH) || null,
          issuedAt,
          paymentDate,
        },
        amounts,
        verification,
        sourceState,
        deterministicChecks,
      },
    };
  }
}

export const invoiceAnalysisContextService =
  new InvoiceAnalysisContextService();
