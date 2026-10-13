import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { commissionOn, isV2Escrow, splitRelease } from '../utils/escrow-commission';

// Provider invoices = the provider's side of the same stage deliveries the client invoices are derived from (client-finance.service). One invoice per delivered stage:
//   client / project / stage / stage value / platform commission / provider net / status.
// Status: 'paid' once the stage is APPROVED (released to the provider's balance), 'due' while it is delivered and waiting for the client's approval.
// Commission: a fee-policy-v2 escrow replays the same cumulative split the release uses (splitRelease), so released stages show exactly what was kept; an unreleased stage shows
// the expected figure at the snapshotted rate (`estimated: true`); a legacy escrow has no commission (released gross).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Row = { contract: any; stage: any; delivery: any; escrow: any; split: { gross: number; commission: number; net: number; estimated: boolean } | null };

export const buildProviderInvoice = ({ contract, stage, delivery, split }: Row) => {
  const stageValue = Number(stage.amount || 0);
  const issuedAt = delivery.submittedAt as Date;
  const status: 'paid' | 'due' = stage.status === 'APPROVED' ? 'paid' : 'due';
  const commission = split ? split.commission : 0;
  const net = split ? split.net : stageValue;
  return {
    id: `PINV-${issuedAt.getFullYear()}-${String(delivery.id).replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    sourceId: delivery.id,
    contractId: contract.id,
    projectId: contract.projectId,
    stageId: stage.id,
    clientName: `${contract.client?.firstName || 'العميل'} ${contract.client?.lastName || ''}`.trim(),
    projectTitle: contract.project?.title ?? '',
    stageTitle: stage.title,
    project: `${contract.project?.title ?? ''} · ${stage.title}`,
    date: issuedAt.toISOString(),
    stageValue,
    platformCommission: commission,
    commissionRatePercent: split && stageValue > 0 ? round2((commission / stageValue) * 100) : 0,
    commissionEstimated: split ? split.estimated : false,
    net,
    total: stageValue,
    tax: 0,
    status,
    paymentDate: status === 'paid' ? (stage.approvedAt || delivery.reviewedAt || null) : null,
    currency: 'USD'
  };
};

/** Per-stage split of one contract: released stages replay splitRelease in approval order; the rest are expected at the snapshotted rate. */
export const splitsForContract = (stages: any[], escrow: any): Map<string, { gross: number; commission: number; net: number; estimated: boolean }> => {
  const out = new Map<string, { gross: number; commission: number; net: number; estimated: boolean }>();
  if (!isV2Escrow(escrow) || escrow.providerCommissionRateSnapshot == null) return out;
  const rate = escrow.providerCommissionRateSnapshot as number;
  let grossSoFar = 0; let commissionSoFar = 0;
  const approved = stages.filter(s => s.status === 'APPROVED').sort((a, b) => (a.approvedAt?.getTime() ?? 0) - (b.approvedAt?.getTime() ?? 0));
  for (const s of approved) {
    const r = splitRelease({ grossReleasedBefore: grossSoFar, commissionTotalBefore: commissionSoFar, grossReleasedAfter: grossSoFar + s.amount, ratePercent: rate });
    out.set(s.id, { gross: r.gross, commission: r.commission, net: r.net, estimated: false });
    grossSoFar = r.grossReleasedAfter; commissionSoFar = r.commissionTotalAfter;
  }
  for (const s of stages) {
    if (out.has(s.id)) continue;
    const c = commissionOn(s.amount, rate);
    out.set(s.id, { gross: s.amount, commission: c, net: round2(s.amount - c), estimated: true });
  }
  return out;
};

const contractInclude = {
  project: { select: { title: true, escrow: true } },
  client: { select: { firstName: true, lastName: true } },
  stages: { orderBy: { stepOrder: 'asc' as const }, include: { deliveries: { orderBy: { submittedAt: 'desc' as const }, take: 1 } } }
};

const invoicesOf = (contract: any) => {
  const splits = splitsForContract(contract.stages, contract.project?.escrow);
  return contract.stages.flatMap((stage: any) => {
    const delivery = stage.deliveries[0];
    return delivery ? [buildProviderInvoice({ contract, stage, delivery, escrow: contract.project?.escrow, split: splits.get(stage.id) ?? null })] : [];
  });
};

export class ProviderInvoicesService {
  async list(providerId: string) {
    const contracts = await prisma.contract.findMany({ where: { providerId }, orderBy: { updatedAt: 'desc' }, include: contractInclude });
    const invoices = contracts.flatMap(invoicesOf).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const paid = invoices.filter((i: any) => i.status === 'paid');
    const due = invoices.filter((i: any) => i.status === 'due');
    return {
      summary: {
        totalCount: invoices.length,
        paidCount: paid.length,
        dueCount: due.length,
        paidNetTotal: round2(paid.reduce((s: number, i: any) => s + i.net, 0)),
        dueNetTotal: round2(due.reduce((s: number, i: any) => s + i.net, 0)),
        platformCommissionTotal: round2(paid.reduce((s: number, i: any) => s + i.platformCommission, 0)),
        currency: 'USD'
      },
      invoices
    };
  }

  /** One invoice by its stage-delivery id; ownership is enforced through the contract's provider. */
  async get(providerId: string, deliveryId: string) {
    const delivery = await prisma.stageDelivery.findFirst({ where: { id: deliveryId, stage: { contract: { providerId } } }, select: { stage: { select: { contractId: true } } } });
    if (!delivery) throw new AppError('الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها', 404);
    const contract = await prisma.contract.findFirst({ where: { id: delivery.stage.contractId, providerId }, include: contractInclude });
    const invoice = contract ? invoicesOf(contract).find((i: any) => i.sourceId === deliveryId) : null;
    if (!invoice) throw new AppError('الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها', 404);
    return invoice;
  }
}

export const providerInvoicesService = new ProviderInvoicesService();
