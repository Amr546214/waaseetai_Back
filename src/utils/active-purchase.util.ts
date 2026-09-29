import { ContractStatus, Prisma } from '@prisma/client';

// Phase 4 — duplicate-purchase prevention ("after buying a marketplace
// project I could go back and buy it again while it is still under
// execution"). A purchase is "active" while the client already has a
// contract-backed Project for that ServiceCatalog item whose contract has not
// reached a terminal state. Only contract-backed projects count: the
// negotiation/"request service" flow creates an OPEN Project with no Contract
// and no payment, which is a conversation, not a purchase. A COMPLETED or
// CANCELLED engagement no longer blocks buying the same service again.
//
// Shared by cart-checkout.service.ts (cart add / order create / the
// authoritative in-transaction gate in confirmPayment) and
// marketplace-service.service.ts (offer-page read-back), so both apply the
// exact same definition. Kept dependency-free on purpose (no service imports).
export const ACTIVE_PURCHASE_CONTRACT_STATUSES: ContractStatus[] = [
  ContractStatus.PENDING_CLIENT_SIGNATURE,
  ContractStatus.PENDING_PAYMENT,
  ContractStatus.PENDING_PROVIDER_SIGNATURE,
  ContractStatus.ACTIVE,
  ContractStatus.DISPUTED
];

export const DUPLICATE_PURCHASE_MESSAGE = 'لديك طلب قائم على هذه الخدمة وما زال قيد التنفيذ — لا يمكن شراؤها مرة أخرى قبل اكتمال المشروع الحالي';

type ProjectFinder = { project: { findMany: (args: Prisma.ProjectFindManyArgs) => Promise<unknown> } };

export interface ActiveServicePurchase {
  id: string;
  serviceCatalogId: string | null;
  title: string;
  status: string;
  contract: { status: ContractStatus } | null;
}

export async function findActiveServicePurchases(client: ProjectFinder, userId: string, serviceIds: string[]): Promise<ActiveServicePurchase[]> {
  const ids = Array.from(new Set(serviceIds.filter(Boolean)));
  if (!ids.length) return [];
  const rows = await client.project.findMany({
    where: { clientId: userId, serviceCatalogId: { in: ids }, contract: { status: { in: ACTIVE_PURCHASE_CONTRACT_STATUSES } } },
    select: { id: true, serviceCatalogId: true, title: true, status: true, contract: { select: { status: true } } },
    orderBy: { createdAt: 'desc' }
  });
  return (rows as ActiveServicePurchase[]) || [];
}
