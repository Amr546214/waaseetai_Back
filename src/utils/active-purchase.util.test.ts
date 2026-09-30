import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_PURCHASE_CONTRACT_STATUSES, findActiveServicePurchases } from './active-purchase.util';

// Regression coverage (Phase 4 test gap): "a COMPLETED or CANCELLED contract
// must not block a client from buying the same service again" was previously
// asserted only implicitly (every existing duplicate-purchase test used an
// empty activePurchases fixture, which is indistinguishable from "filtered
// out because terminal" vs. "there was never any purchase at all"). These
// tests make the terminal-status exclusion explicit and would fail if
// COMPLETED/CANCELLED were ever accidentally added back to the active list.

test('ACTIVE_PURCHASE_CONTRACT_STATUSES deliberately excludes both terminal statuses (COMPLETED, CANCELLED)', () => {
  assert.ok(!ACTIVE_PURCHASE_CONTRACT_STATUSES.includes('COMPLETED' as any), 'COMPLETED must never block a re-purchase');
  assert.ok(!ACTIVE_PURCHASE_CONTRACT_STATUSES.includes('CANCELLED' as any), 'CANCELLED must never block a re-purchase');
});

/**
 * A minimal fake Prisma `project.findMany` that actually HONORS the same
 * where-clause shape findActiveServicePurchases sends (clientId match,
 * serviceCatalogId in list, contract.status in list) by filtering a fixed
 * fixture array itself — simulating real Postgres-side filtering, rather
 * than just echoing back whatever the test wants returned. This is what
 * makes the COMPLETED/CANCELLED assertions below meaningful: they would
 * fail if ACTIVE_PURCHASE_CONTRACT_STATUSES ever regressed to include a
 * terminal status.
 */
function makeFakeProjectClient(rows: any[]) {
  return {
    project: {
      findMany: async (args: any) => {
        const { clientId, serviceCatalogId, contract } = args.where;
        const allowedStatuses: string[] = contract.status.in;
        const allowedServiceIds: string[] = serviceCatalogId.in;
        return rows.filter(row =>
          row.clientId === clientId &&
          allowedServiceIds.includes(row.serviceCatalogId) &&
          allowedStatuses.includes(row.contract?.status)
        );
      }
    }
  };
}

for (const terminalStatus of ['COMPLETED', 'CANCELLED']) {
  test(`findActiveServicePurchases: a ${terminalStatus} contract for the same client/service does NOT block re-purchase (returns empty)`, async () => {
    const rows = [
      { id: 'project-old', clientId: 'user-1', serviceCatalogId: 'service-1', title: 'Service', status: terminalStatus, contract: { status: terminalStatus } }
    ];
    const client = makeFakeProjectClient(rows);

    const result = await findActiveServicePurchases(client, 'user-1', ['service-1']);

    assert.deepEqual(result, [], `a ${terminalStatus} contract must be treated as no active purchase at all`);
  });
}

test('findActiveServicePurchases: a non-terminal (ACTIVE) contract for the same client/service is still correctly detected', async () => {
  const rows = [
    { id: 'project-1', clientId: 'user-1', serviceCatalogId: 'service-1', title: 'Service', status: 'IN_PROGRESS', contract: { status: 'ACTIVE' } }
  ];
  const client = makeFakeProjectClient(rows);

  const result = await findActiveServicePurchases(client, 'user-1', ['service-1']);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'project-1');
});

test('findActiveServicePurchases: a mix of one COMPLETED and one ACTIVE project for the same service only surfaces the ACTIVE one', async () => {
  const rows = [
    { id: 'project-old', clientId: 'user-1', serviceCatalogId: 'service-1', title: 'Service', status: 'COMPLETED', contract: { status: 'COMPLETED' } },
    { id: 'project-new', clientId: 'user-1', serviceCatalogId: 'service-1', title: 'Service', status: 'IN_PROGRESS', contract: { status: 'ACTIVE' } }
  ];
  const client = makeFakeProjectClient(rows);

  const result = await findActiveServicePurchases(client, 'user-1', ['service-1']);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'project-new');
});

test('findActiveServicePurchases: no service ids returns empty without querying the client', async () => {
  let called = false;
  const client = { project: { findMany: async () => { called = true; return []; } } };

  const result = await findActiveServicePurchases(client, 'user-1', []);

  assert.deepEqual(result, []);
  assert.equal(called, false, 'an empty id list must short-circuit before any DB call');
});
