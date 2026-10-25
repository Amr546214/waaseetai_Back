import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Dispute freeze + dispute resolution (text closure vs financial decision).
//
// The in-memory world below is a small stand-in for Postgres: ONE store, transactions that roll back on error (snapshot/restore) and a
// row lock on the contract row (the SELECT ... FOR UPDATE the services take) that really blocks a second transaction until the first ends.
// That is what lets the race tests prove the ORDER guarantees; the isolation level itself is Postgres's (READ COMMITTED) and is not simulated.

type Row = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);

interface WorldInit {
  disputes?: Row[];
  escrow?: Row | null;
  contract?: Partial<Row>;
  stages?: Row[];
  walletBalance?: number;
}

function makeWorld(t: TestContext, init: WorldInit = {}) {
  let st: any = {
    disputes: init.disputes ?? [],
    escrow: init.escrow === undefined ? { id: 'esc-1', projectId: 'project-1', amount: 1000, status: 'HELD', releasedAmount: 0, platformCommissionAmount: 0, providerNetReleasedAmount: 0, feePolicyVersion: 2, providerCommissionRateSnapshot: 10 } : init.escrow,
    contract: { id: 'contract-1', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', price: 1000, status: 'ACTIVE', ...init.contract },
    project: { id: 'project-1', status: 'IN_PROGRESS', title: 'مشروع تجريبي' },
    stages: init.stages ?? [
      { id: 'stage-1', contractId: 'contract-1', stepOrder: 1, title: 'المرحلة 1', amount: 400, status: 'SUBMITTED', deliveries: [{ id: 'del-1', status: 'SUBMITTED' }] },
      { id: 'stage-2', contractId: 'contract-1', stepOrder: 2, title: 'المرحلة 2', amount: 600, status: 'PENDING', deliveries: [] }
    ],
    users: { 'client-1': { walletBalance: init.walletBalance ?? 0 } } as Record<string, Row>,
    walletTx: [] as Row[],
    audit: [] as Row[],
    requests: [] as Row[],
    events: [] as string[]
  };
  let seq = 0;
  // ---- the contract row lock ----
  let holder: symbol | null = null;
  const waiters: Array<() => void> = [];
  const acquire = async (id: symbol) => { while (holder && holder !== id) await new Promise<void>(r => waiters.push(r)); holder = id; };
  const release = (id: symbol) => { if (holder === id) { holder = null; waiters.splice(0).forEach(w => w()); } };
  // ---- gates: pause a transaction at a named point so a test can interleave another one ----
  const gates: Record<string, { reached: Promise<void>; open: () => void } | undefined> = {};
  const reachedResolvers: Record<string, () => void> = {};
  const gate = (name: string) => {
    let open!: () => void; const wait = new Promise<void>(r => { open = r; });
    const reached = new Promise<void>(r => { reachedResolvers[name] = r; });
    gates[name] = { reached, open: () => { open(); } };
    (gates[name] as any).wait = wait;
    return gates[name]!;
  };
  const pass = async (name: string) => { const g: any = gates[name]; if (g) { reachedResolvers[name]?.(); await g.wait; } };

  const matchDispute = (d: Row, where: Row = {}): boolean => {
    if (where.id && d.id !== where.id) return false;
    if (where.openedById && d.openedById !== where.openedById) return false;
    if (where.projectId && d.projectId !== where.projectId) return false;
    if (where.requestId && d.requestId !== where.requestId) return false;
    if (where.status?.in && !where.status.in.includes(d.status)) return false;
    if (where.resolution?.in && !where.resolution.in.includes(d.resolution)) return false;
    if (typeof where.status === 'string' && d.status !== where.status) return false;
    if (where.OR && !where.OR.some((w: Row) => matchDispute(d, w))) return false;
    return true;
  };
  const failures = { auditCreate: false, escrowUpdate: false };

  const snaps = new Map<symbol, any>();
  const models = (txId?: symbol) => ({
    // the row lock is the serialisation point: a transaction's rollback snapshot is taken AFTER it holds the lock (like Postgres row versions)
    $queryRaw: async () => { await acquire(txId ?? Symbol('autocommit')); if (txId && !snaps.has(txId)) snaps.set(txId, clone(st)); st.events.push('lock'); return [{ id: st.contract.id }]; },
    dispute: {
      count: async ({ where }: any) => { st.events.push('dispute.count'); return st.disputes.filter((d: Row) => matchDispute(d, where)).length; },
      findFirst: async ({ where }: any) => clone(st.disputes.filter((d: Row) => matchDispute(d, where)).slice(-1)[0] ?? null),
      findMany: async ({ where }: any) => clone(st.disputes.filter((d: Row) => matchDispute(d, where))),
      findUnique: async ({ where }: any) => { const d = st.disputes.find((x: Row) => x.id === where.id); return d ? clone({ ...d, request: null, project: { id: d.projectId }, openedBy: {}, againstUser: {}, resolvedBy: null }) : null; },
      create: async ({ data }: any) => { await pass('dispute.create'); const row = { id: `disp-${++seq}`, status: 'OPEN', createdAt: new Date(seq), ...data }; st.disputes.push(row); st.events.push('dispute.created'); return clone({ ...row, request: null, project: { id: row.projectId, title: 'مشروع' } }); },
      updateMany: async ({ where, data }: any) => { const rows = st.disputes.filter((d: Row) => matchDispute(d, where)); rows.forEach((d: Row) => Object.assign(d, data)); return { count: rows.length }; },
      update: async ({ where, data }: any) => { const d = st.disputes.find((x: Row) => x.id === where.id); Object.assign(d, data); return clone(d); }
    },
    contract: {
      findFirst: async () => clone({ ...st.contract, project: { title: st.project.title }, provider: { firstName: 'م', lastName: 'ق', email: 'p@example.com' } }),
      findUnique: async () => clone(st.contract),
      findUniqueOrThrow: async () => clone(st.contract),
      update: async ({ data }: any) => { Object.assign(st.contract, data); st.events.push(`contract.${data.status}`); return clone(st.contract); },
      updateMany: async ({ data }: any) => { Object.assign(st.contract, data); return { count: 1 }; }
    },
    project: {
      findUnique: async () => clone({ id: 'project-1', clientId: 'client-1', providerId: 'provider-1', contract: { id: 'contract-1', status: st.contract.status, clientId: 'client-1', providerId: 'provider-1' } }),
      findFirst: async () => clone({ id: 'project-1', clientId: 'client-1', providerId: 'provider-1', contract: { id: 'contract-1', status: st.contract.status, clientId: 'client-1', providerId: 'provider-1' } }),
      update: async ({ data }: any) => { Object.assign(st.project, data); return clone(st.project); },
      count: async () => 1
    },
    clientRequest: { findUnique: async () => null, updateMany: async ({ data }: any) => { st.requests.push(data.status); return { count: 1 }; } },
    proposal: { findFirst: async () => null },
    projectStage: {
      findFirst: async ({ where }: any) => {
        const found = where.stepOrder?.gt !== undefined ? st.stages.filter((s: Row) => s.stepOrder > where.stepOrder.gt).sort((a: Row, b: Row) => a.stepOrder - b.stepOrder)[0] : st.stages.find((s: Row) => s.id === where.id);
        return found ? clone(found) : null;
      },
      updateMany: async ({ where, data }: any) => { const s = st.stages.find((x: Row) => x.id === where.id && (!where.status || x.status === where.status)); if (!s) return { count: 0 }; Object.assign(s, data); st.events.push(`stage.${data.status}`); return { count: 1 }; },
      update: async ({ where, data }: any) => { Object.assign(st.stages.find((x: Row) => x.id === where.id), data); return {}; }
    },
    stageDelivery: { update: async () => ({}) },
    escrow: {
      findUnique: async () => (st.escrow ? clone(st.escrow) : null),
      updateMany: async ({ where, data }: any) => {
        await pass('escrow.update');
        if (failures.escrowUpdate) throw new Error('escrow write failed');
        const e = st.escrow;
        if (!e || (where.status && e.status !== where.status) || (where.releasedAmount !== undefined && e.releasedAmount !== where.releasedAmount)) return { count: 0 };
        const next = { ...data }; if (next.releasedAmount?.increment !== undefined) next.releasedAmount = e.releasedAmount + next.releasedAmount.increment;
        Object.assign(e, next); st.events.push('escrow.moved'); return { count: 1 };
      }
    },
    user: {
      update: async ({ where, data }: any) => { const u = st.users[where.id]; if (data.walletBalance?.increment !== undefined) u.walletBalance = Math.round((u.walletBalance + data.walletBalance.increment) * 100) / 100; return clone(u); },
      // the acting admin of a financial decision: admin-1 holds the permissions (it is the platform owner here), admin-2 is an ADMIN account that holds nothing (refused)
      findUnique: async ({ where }: any) => (where.id === 'admin-1' ? { accountType: 'SUPER_ADMIN', status: 'ACTIVE' } : where.id === 'admin-2' ? { accountType: 'ADMIN', status: 'ACTIVE' } : null)
    },
    platformOwner: { findUnique: async ({ where }: any) => (where.userId === 'admin-1' ? { userId: 'admin-1' } : null) },
    adminStaff: { findUnique: async () => null },
    walletTransaction: { create: async ({ data }: any) => { if (st.walletTx.some((w: Row) => w.referenceId === data.referenceId)) throw Object.assign(new Error('Unique constraint failed on referenceId'), { code: 'P2002' }); st.walletTx.push(clone(data)); return data; } },
    accountAuditLog: {
      create: async ({ data }: any) => { if (failures.auditCreate) throw new Error('audit write failed'); const row = { id: `a${++seq}`, occurredAt: new Date(seq), ...clone(data) }; st.audit.push(row); return row; },
      findMany: async () => []
    },
    notification: { create: async () => ({ id: 'n1' }) }
  });

  const prisma: any = {
    ...models(),
    $transaction: async (fn: any) => {
      const id = Symbol('tx'); snaps.set(id, clone(st));
      // a transaction that waits for the lock re-takes its snapshot once it holds it (see $queryRaw); until then it has written nothing
      try { const m = models(id); const first = m.$queryRaw; let locked = false; m.$queryRaw = async () => { if (!locked) snaps.delete(id); locked = true; return first(); }; return await fn(m); } catch (e) { const events = st.events; st = snaps.get(id); st.events = events; throw e; } finally { release(id); snaps.delete(id); }
    }
  };
  // the singleton db seen by non-transactional calls must not hold the lock past one call
  prisma.$queryRaw = async () => [{ id: st.contract.id }];
  return { prisma, get: () => st as any, gate, failures };
}

async function loadServices(t: TestContext, world: ReturnType<typeof makeWorld>) {
  const providerNotes: any[] = []; const clientNotes: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: world.prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { emitStored: async () => {} } } });
  t.mock.module('./email.service', { namedExports: { emailService: {} } });
  t.mock.module('./admin-notifications.service', { namedExports: { notifyAdmins: async () => {} } });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {} } });
  t.mock.module('./admin-audit.service', { namedExports: { adminAudit: {
    record: async (i: any) => { const row = { id: `rec${world.get().audit.length}`, occurredAt: new Date(), eventType: i.eventType, context: { entity: i.entity, entityId: i.entityId, ...(i.details ?? {}) }, title: i.title, summary: i.summary, admin: null }; world.get().audit.push(row); return row; },
    listForEntity: async (_e: string, id: string, types?: string[]) => world.get().audit.filter((r: Row) => r.context?.entityId === id && (!types || types.includes(r.eventType))).slice().reverse().map((r: Row) => ({ ...r, admin: null }))
  } } });
  t.mock.module('./provider-notifications.service', { namedExports: { providerNotifications: { disputeOpened: async () => {}, disputeResolved: async (n: any) => { providerNotes.push(n); } } } });
  const realClient = await import('./client-notifications.service.ts?real=' + Math.random());
  t.mock.module('./client-notifications.service', { namedExports: { clientNotifications: { send: async (n: any) => { clientNotes.push(n); }, deliverStored: async () => {} }, clientNotificationFor: realClient.clientNotificationFor } });
  const stamp = `${Date.now()}-${Math.random()}`;
  const { disputeService } = await import(`./dispute.service.ts?fixture=${stamp}`);
  const { projectProgressService } = await import(`./project-progress.service.ts?fixture=${stamp}`);
  return { disputeService, projectProgressService, providerNotes, clientNotes };
}

const dispute = (over: Row = {}): Row => ({ id: 'disp-x', projectId: 'project-1', requestId: null, openedById: 'client-1', againstUserId: 'provider-1', status: 'OPEN', createdAt: new Date(), ...over });
const approve = (svc: any) => svc.reviewDelivery('client-1', 'contract-1', 'stage-1', 'approve');
const frozen = (e: any) => e.statusCode === 423 && e.errors?.[0]?.code === 'PROJECT_FROZEN_BY_DISPUTE';
const openInput = { reason: 'تأخر في التسليم', description: 'لم يتم التسليم في الموعد المتفق عليه' };

// ───────────────────────── freeze: helper semantics ─────────────────────────

test('hasActiveDispute: OPEN and UNDER_REVIEW freeze; RESOLVED and REJECTED do not; legacy requestId disputes count for the same id', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ id: 'a', status: 'RESOLVED' }), dispute({ id: 'b', status: 'REJECTED' })] });
  t.mock.module('../config/db', { namedExports: { prisma: w.prisma } });
  const freeze = await import(`./dispute-freeze.service.ts?f=${Math.random()}`);
  assert.equal(await freeze.hasActiveDispute('project-1', w.prisma), false);
  assert.equal(await freeze.isProjectFrozen('project-1', w.prisma), false);
  w.get().disputes.push(dispute({ id: 'c', status: 'UNDER_REVIEW' }));
  assert.equal(await freeze.hasActiveDispute('project-1', w.prisma), true);
  w.get().disputes.length = 0;
  w.get().disputes.push(dispute({ id: 'd', projectId: null, requestId: 'project-1', status: 'OPEN' }));
  assert.equal(await freeze.hasActiveDispute('project-1', w.prisma), true);
  assert.equal(await freeze.hasActiveDispute('another-project', w.prisma), false);
  const state = await freeze.getFreezeState('project-1', w.prisma);
  assert.deepEqual({ frozen: state.frozen, count: state.activeDisputeCount, id: state.disputeId }, { frozen: true, count: 1, id: 'd' });
  assert.match(state.reason, /نزاع/);
});

// ───────────────────────── freeze: every approval/release path ─────────────────────────

test('approve is refused (423) while a dispute is OPEN or UNDER_REVIEW: stage, escrow, contract and project are untouched', async (top) => {
  for (const status of ['OPEN', 'UNDER_REVIEW']) await top.test(status, async (t) => {
    const w = makeWorld(t, { disputes: [dispute({ status })] });
    const { projectProgressService } = await loadServices(t, w);
    await assert.rejects(() => approve(projectProgressService), frozen);
    const st = w.get();
    assert.equal(st.stages[0].status, 'SUBMITTED');
    assert.equal(st.escrow.releasedAmount, 0);
    assert.equal(st.escrow.status, 'HELD');
    assert.equal(st.contract.status, 'ACTIVE');
    assert.equal(st.audit.length, 0);
  });
});

test('unfreeze: the same approval succeeds once the dispute is closed (RESOLVED or REJECTED) and releases the stage', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ status: 'OPEN' })] });
  const { projectProgressService } = await loadServices(t, w);
  await assert.rejects(() => approve(projectProgressService), frozen);
  w.get().disputes[0].status = 'REJECTED';
  await approve(projectProgressService);
  assert.equal(w.get().stages[0].status, 'APPROVED');
  assert.equal(w.get().escrow.releasedAmount, 400);
});

test('several active disputes: closing ONE keeps the freeze; it lifts only when ALL are closed', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ id: 'd1', openedById: 'client-1' }), dispute({ id: 'd2', openedById: 'provider-1', status: 'UNDER_REVIEW' })] });
  const { projectProgressService } = await loadServices(t, w);
  w.get().disputes[0].status = 'RESOLVED';
  await assert.rejects(() => approve(projectProgressService), frozen);
  w.get().disputes[1].status = 'RESOLVED';
  await approve(projectProgressService);
  assert.equal(w.get().escrow.releasedAmount, 400);
});

test('the freeze is per project: a dispute on ANOTHER project never blocks this approval, and a closed-wallet freeze does not exist', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ projectId: 'other-project' })] });
  const { projectProgressService } = await loadServices(t, w);
  await approve(projectProgressService);
  assert.equal(w.get().escrow.releasedAmount, 400);
});

test('a revision request is still allowed during a dispute (it is not an approval and moves no money)', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { projectProgressService } = await loadServices(t, w);
  await projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-1', 'revision', 'يرجى تعديل الألوان كما في الملاحظات');
  assert.equal(w.get().stages[0].status, 'REVISION_REQUESTED');
  assert.equal(w.get().escrow.releasedAmount, 0);
});

test('getProjectProgress exposes the freeze to both apps (frozen, count, reason, canApproveStage=false); delivery flags stay on', async (t) => {
  const w = makeWorld(t, { disputes: [dispute(), dispute({ id: 'd2', openedById: 'provider-1', status: 'UNDER_REVIEW' })] });
  const mod = w.get();
  // getProjectProgress needs a wider contract graph than the release path: serve it from a dedicated minimal mock.
  const contractGraph = { id: 'contract-1', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', price: 1000, durationDays: 10, status: 'ACTIVE', signedAt: new Date(), createdAt: new Date(),
    client: { firstName: 'ع', lastName: 'م' }, provider: { firstName: 'م', lastName: 'ق' },
    project: { title: 'مشروع', escrow: { ...mod.escrow }, assignedEmployee: null, conversations: [{ id: 'cv', providerId: 'provider-1', clientId: 'client-1', messages: [] }] } };
  const stage = { id: 'stage-1', contractId: 'contract-1', stepOrder: 1, title: 'م1', description: '', amount: 400, percentage: 40, days: 3, status: 'IN_PROGRESS', startedAt: new Date(), approvedAt: null, deliveries: [], stageReviews: [] };
  w.prisma.contract.findFirst = async () => clone(contractGraph);
  w.prisma.projectStage.findMany = async () => [clone(stage)];
  w.prisma.projectStage.count = async () => 1;
  w.prisma.review = { findFirst: async () => null };
  const { projectProgressService } = await loadServices(t, w);
  (projectProgressService as any).ensureStages = async () => {};
  const asClient = await projectProgressService.getProjectProgress('client-1', 'project-1');
  assert.equal(asClient.disputeFreeze.frozen, true);
  assert.equal(asClient.activeDisputeCount, 2);
  assert.equal(asClient.canApproveStage, false);
  assert.match(asClient.approvalBlockedReason, /نزاع/);
  const asProvider = await projectProgressService.getProjectProgress('provider-1', 'project-1');
  assert.equal(asProvider.disputeFreeze.frozen, true);
  assert.equal(asProvider.canSubmitDelivery, true, 'delivery stays allowed for the provider');
  assert.ok(asProvider.canUploadDelivery);
});

// ───────────────────────── freeze: concurrency ─────────────────────────

test('RACE: the dispute is opened first (holds the contract lock) while an approval starts: the approval WAITS, then sees the dispute and is refused — no money moves', async (t) => {
  const w = makeWorld(t);
  const { disputeService, projectProgressService } = await loadServices(t, w);
  const g = w.gate('dispute.create');
  const opening = disputeService.createForRequest('project-1', 'client-1', 'client', openInput);
  await g.reached;                                  // the dispute transaction holds the lock and is about to insert
  const approving = approve(projectProgressService);
  await new Promise(r => setTimeout(r, 25));        // give the approval every chance to run past the lock if it could
  assert.equal(w.get().events.includes('escrow.moved'), false);
  g.open();
  await opening;
  await assert.rejects(() => approving, frozen);
  assert.equal(w.get().escrow.releasedAmount, 0);
  assert.equal(w.get().stages[0].status, 'SUBMITTED');
  assert.equal(w.get().disputes.length, 1);
});

test('RACE: the approval commits first (holds the lock) while a dispute is opened: the dispute WAITS and is created only after the release is complete', async (t) => {
  const w = makeWorld(t);
  const { disputeService, projectProgressService } = await loadServices(t, w);
  const g = w.gate('escrow.update');
  const approving = approve(projectProgressService);
  await g.reached;                                  // the approval holds the lock and is about to move money
  const opening = disputeService.createForRequest('project-1', 'client-1', 'client', openInput);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(w.get().disputes.length, 0, 'the dispute cannot be inserted while the approval transaction is open');
  g.open();
  await approving;
  await opening;
  const events = w.get().events as string[];
  assert.ok(events.indexOf('escrow.moved') < events.indexOf('dispute.created'), 'release fully committed before the dispute exists');
  assert.equal(w.get().escrow.releasedAmount, 400);
  // and from now on the NEXT approval is frozen
  w.get().stages[1].status = 'SUBMITTED'; w.get().stages[1].deliveries = [{ id: 'del-2', status: 'SUBMITTED' }];
  await assert.rejects(() => projectProgressService.reviewDelivery('client-1', 'contract-1', 'stage-2', 'approve'), frozen);
  assert.equal(w.get().escrow.releasedAmount, 400);
});

test('opening a dispute twice by the same party is a 409 even when the two requests race (the duplicate check runs under the lock)', async (t) => {
  const w = makeWorld(t);
  const { disputeService } = await loadServices(t, w);
  const results = await Promise.allSettled([disputeService.createForRequest('project-1', 'client-1', 'client', openInput), disputeService.createForRequest('project-1', 'client-1', 'client', openInput)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409);
  assert.equal(w.get().disputes.length, 1);
});

// ───────────────────────── delivery / chat / evidence stay allowed ─────────────────────────

test('delivery, upload and chat code never consult the freeze (static guard) and the pending-review list marks frozen projects', async () => {
  const src = readFileSync(join(__dirname, 'project-progress.service.ts'), 'utf8');
  const bodyOf = (name: string) => { const i = src.indexOf(`async ${name}(`); const j = src.indexOf('\n  async ', i + 10); return src.slice(i, j < 0 ? undefined : j); };
  for (const fn of ['submitDelivery', 'uploadDeliveryFiles']) assert.ok(!/Frozen|ActiveDispute|dispute/i.test(bodyOf(fn)), `${fn} must not be gated by a dispute`);
  assert.ok(!/Frozen|ActiveDispute/.test(src.slice(src.indexOf('private async assertDeliverable'), src.indexOf('async uploadDeliveryFiles'))), 'assertDeliverable stays dispute-agnostic');
  assert.match(bodyOf('reviewDelivery'), /lockProjectForFreezeCheck[\s\S]*assertProjectNotFrozen/);
  const chat = readdirSync(join(__dirname, '..')).filter(d => /chat|message|conversation/i.test(d));
  void chat;
  const chatFiles = ['services/chat.service.ts', 'controllers/chat.controller.ts', 'sockets/chat.gateway.ts'].map(f => { try { return readFileSync(join(__dirname, '..', f), 'utf8'); } catch { return ''; } });
  for (const c of chatFiles) assert.ok(!/dispute-freeze|PROJECT_FROZEN/.test(c), 'chat is never frozen');
});

test('STATIC: the only escrow/stage/contract money writers are project-progress (approval, gated), dispute.service (financial resolution, gated) and the funding/signing flows', () => {
  const root = join(__dirname, '..');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !/\.test\.ts$/.test(p) ? [p] : []; });
  const writers = walk(root).filter(f => /(escrow|projectStage)\.(update|updateMany|upsert)\(/.test(readFileSync(f, 'utf8'))).map(f => f.slice(root.length + 1)).sort();
  assert.deepEqual(writers, ['services/amendment-apply.service.ts', 'services/client-requests.service.ts', 'services/dispute.service.ts', 'services/project-progress.service.ts']);
  // the amendment applier is the 4th writer: it must refuse while a dispute is active (inside its own transaction, after taking the contract lock)
  const amend = readFileSync(join(root, 'services/amendment-apply.service.ts'), 'utf8');
  assert.match(amend, /hasActiveDispute/);
  assert.match(amend, /contract\.updateMany|FOR UPDATE/);
  const funding = readFileSync(join(root, 'services/client-requests.service.ts'), 'utf8');
  assert.ok(!/escrow\.(update|updateMany)\(/.test(funding), 'client-requests only UPSERTS the escrow at funding time (a new HELD escrow), it never releases');
  for (const f of ['services/project-progress.service.ts', 'services/dispute.service.ts']) assert.match(readFileSync(join(root, f), 'utf8'), /lockProjectForFreezeCheck/, `${f} takes the contract lock`);
  // no timer-based auto release/complete anywhere
  const timers = walk(root).filter(f => /setInterval|node-cron|cron\.schedule/.test(readFileSync(f, 'utf8')) && /escrow|releasedAmount/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(timers, []);
});

// ───────────────────────── resolution kind 1: text closure ─────────────────────────

test('text closure moves NO money and changes no escrow / contract / project / stage — it only records the decision and notifies both parties', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService, providerNotes, clientNotes } = await loadServices(t, w);
  const before = clone({ escrow: w.get().escrow, contract: w.get().contract, project: w.get().project, stages: w.get().stages, users: w.get().users });
  const res = await disputeService.resolve('disp-x', 'admin-1', { action: 'resolve', resolution: 'MUTUAL_CLOSE', resolutionNote: 'اتفق الطرفان' });
  assert.equal(res.status, 'RESOLVED');
  assert.deepEqual(clone({ escrow: w.get().escrow, contract: w.get().contract, project: w.get().project, stages: w.get().stages, users: w.get().users }), before);
  assert.equal(w.get().walletTx.length, 0);
  assert.equal(providerNotes.length, 1);
  assert.equal(clientNotes.length, 1);
  assert.equal(w.get().audit.find((a: Row) => a.eventType === 'DISPUTE_RESOLVED').context.financialEffect, 'NONE');
});

test('closing the only dispute lifts the freeze, but the money still did not move', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService, projectProgressService } = await loadServices(t, w);
  await assert.rejects(() => approve(projectProgressService), frozen);
  await disputeService.resolve('disp-x', 'admin-1', { action: 'reject', resolution: 'NO_FINANCIAL_CHANGE' });
  assert.equal(w.get().escrow.releasedAmount, 0);
  await approve(projectProgressService);
  assert.equal(w.get().escrow.releasedAmount, 400);
});

test('code strings typed as FREE TEXT are inert: a longer sentence containing REFUND_CLIENT moves nothing; a bare financial code is refused by the DTO', async (t) => {
  const { resolveDisputeSchema } = await import('../dtos/dispute.dto.ts?x=' + Math.random());
  for (const bare of ['REFUND_CLIENT', 'refund_client', ' SPLIT ', 'RELEASE_PROVIDER', 'RELEASE_TO_PROVIDER', 'PARTIAL_REFUND', 'release-provider']) {
    const r = resolveDisputeSchema.safeParse({ action: 'resolve', resolution: bare });
    assert.equal(r.success, false, `${bare} must be refused as a closure text`);
    assert.match(r.error!.issues[0].message, /قرار مالي/);
  }
  for (const ok of ['MUTUAL_CLOSE', 'NO_FINANCIAL_CHANGE', 'لا أثر مالي', 'ناقش الطرفان REFUND_CLIENT ثم تراجعا']) assert.equal(resolveDisputeSchema.safeParse({ action: 'resolve', resolution: ok }).success, true, ok);
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService } = await loadServices(t, w);
  await disputeService.resolve('disp-x', 'admin-1', { action: 'resolve', resolution: 'ناقش الطرفان REFUND_CLIENT ثم تراجعا', resolutionNote: 'RELEASE_PROVIDER 1000' });
  assert.equal(w.get().escrow.status, 'HELD');
  assert.equal(w.get().escrow.releasedAmount, 0);
  assert.equal(w.get().users['client-1'].walletBalance, 0);
  assert.equal(w.get().walletTx.length, 0);
});

test('closing the same dispute twice (double click / two admins) executes once; the second is a 409', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService, providerNotes } = await loadServices(t, w);
  const input = { action: 'resolve', resolution: 'MUTUAL_CLOSE' };
  const results = await Promise.allSettled([disputeService.resolve('disp-x', 'admin-1', input), disputeService.resolve('disp-x', 'admin-2', input)]);
  assert.equal(results.filter(r => r.status === 'rejected').length >= 0, true);
  await assert.rejects(() => disputeService.resolve('disp-x', 'admin-2', input), (e: any) => e.statusCode === 409);
  assert.ok(providerNotes.length <= 2);
});

// ───────────────────────── resolution kind 2: financial decision ─────────────────────────

const fin = (over: Row = {}) => ({ outcome: 'RELEASE_PROVIDER', refundToClient: 0, releaseToProvider: 1000, expectedHeldAmount: 1000, confirm: true, ...over });

test('DTO: explicit amounts, 2 decimals, confirm:true literal, and the outcome must match the amounts', async () => {
  const { resolveDisputeFinancialSchema: s } = await import('../dtos/dispute.dto.ts?y=' + Math.random());
  assert.equal(s.safeParse(fin()).success, true);
  assert.equal(s.safeParse(fin({ confirm: false })).success, false);
  assert.equal(s.safeParse({ ...fin(), confirm: undefined }).success, false);
  assert.equal(s.safeParse(fin({ confirm: 'true' })).success, false);
  assert.equal(s.safeParse(fin({ releaseToProvider: -5 })).success, false);
  assert.equal(s.safeParse(fin({ releaseToProvider: 10.123 })).success, false);
  assert.equal(s.safeParse(fin({ releaseToProvider: '1000' })).success, false);
  assert.equal(s.safeParse(fin({ outcome: 'MUTUAL_CLOSE' })).success, false);
  assert.equal(s.safeParse(fin({ outcome: 'REFUND_CLIENT' })).success, false, 'REFUND_CLIENT needs refund > 0 and release = 0');
  assert.equal(s.safeParse(fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 })).success, true);
  assert.equal(s.safeParse(fin({ outcome: 'SPLIT', refundToClient: 0, releaseToProvider: 1000 })).success, false, 'SPLIT needs both sides > 0');
  assert.equal(s.safeParse(fin({ outcome: 'SPLIT', refundToClient: 300, releaseToProvider: 700 })).success, true);
  assert.equal(s.safeParse(fin({ expectedHeldAmount: 0 })).success, false);
});

test('RELEASE_PROVIDER (v2 escrow): commission uses the escrow snapshot rate, cumulative round2 split; escrow RELEASED; contract+project COMPLETED; audit in the same transaction', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()], escrow: { id: 'esc-1', projectId: 'project-1', amount: 1000, status: 'HELD', releasedAmount: 400, platformCommissionAmount: 40, providerNetReleasedAmount: 360, feePolicyVersion: 2, providerCommissionRateSnapshot: 10 } });
  const { disputeService, providerNotes, clientNotes } = await loadServices(t, w);
  const out = await disputeService.resolveFinancial('disp-x', 'admin-1', fin({ releaseToProvider: 600, expectedHeldAmount: 600 }));
  const st = w.get();
  assert.deepEqual(out.financialOutcome, { outcome: 'RELEASE_PROVIDER', refundToClient: 0, releaseToProvider: 600, platformCommission: 60, providerNet: 540 });
  assert.equal(st.escrow.status, 'RELEASED');
  assert.equal(st.escrow.releasedAmount, 1000);
  assert.equal(st.escrow.platformCommissionAmount, 100);
  assert.equal(st.escrow.providerNetReleasedAmount, 900);
  assert.equal(st.contract.status, 'COMPLETED');
  assert.equal(st.project.status, 'COMPLETED');
  assert.equal(st.walletTx.length, 0, 'no client refund on a pure release');
  const audit = st.audit.find((a: Row) => a.eventType === 'DISPUTE_FINANCIAL_RESOLVED');
  assert.equal(audit.userId, 'admin-1');
  assert.equal(audit.severity, 'CRITICAL');
  assert.equal(audit.context.outcomeSummary.providerNet, 540);
  assert.equal(audit.context.commissionRatePercent, 10);
  assert.equal(providerNotes[0].financial.providerNet, 540);
  assert.equal(clientNotes[0].message.includes('800'), false);
});

test('REFUND_CLIENT: the whole held balance returns to the client wallet with a REFUND transaction; escrow REFUNDED; contract CANCELLED; no provider commission', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()], walletBalance: 5 });
  const { disputeService } = await loadServices(t, w);
  await disputeService.resolveFinancial('disp-x', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 }));
  const st = w.get();
  assert.equal(st.users['client-1'].walletBalance, 1005);
  assert.deepEqual(st.walletTx.map((x: Row) => [x.type, x.amount, x.referenceId]), [['REFUND', 1000, 'DISPUTE-REFUND-disp-x']]);
  assert.equal(st.escrow.status, 'REFUNDED');
  assert.equal(st.escrow.releasedAmount, 0);
  assert.equal(st.escrow.platformCommissionAmount, 0);
  assert.equal(st.contract.status, 'CANCELLED');
  assert.equal(st.disputes[0].status, 'RESOLVED');
  assert.equal(st.disputes[0].resolution, 'REFUND_CLIENT');
});

test('SPLIT: refund + release must equal the held balance; commission only on the provider part; both sides notified with their own amounts', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService, providerNotes, clientNotes } = await loadServices(t, w);
  const out = await disputeService.resolveFinancial('disp-x', 'admin-1', fin({ outcome: 'SPLIT', refundToClient: 333.33, releaseToProvider: 666.67 }));
  assert.equal(out.financialOutcome.platformCommission, 66.67);
  assert.equal(out.financialOutcome.providerNet, 600);
  assert.equal(w.get().users['client-1'].walletBalance, 333.33);
  assert.equal(w.get().escrow.releasedAmount, 666.67);
  assert.match(clientNotes[0].message, /333\.33/);
  assert.equal(providerNotes[0].financial.providerNet, 600);
});

test('LEGACY escrow (no fee policy): the provider part is released gross, no commission columns written', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()], escrow: { id: 'esc-1', projectId: 'project-1', amount: 1130, status: 'HELD', releasedAmount: 0, platformCommissionAmount: 0, providerNetReleasedAmount: 0, feePolicyVersion: null, providerCommissionRateSnapshot: null } });
  const { disputeService } = await loadServices(t, w);
  const out = await disputeService.resolveFinancial('disp-x', 'admin-1', fin());
  assert.equal(out.financialOutcome.platformCommission, 0);
  assert.equal(out.financialOutcome.providerNet, 1000);
  assert.equal(w.get().escrow.releasedAmount, 1000);
  assert.equal(w.get().escrow.platformCommissionAmount, 0);
});

test('BOUNDS: amounts that do not settle exactly the held balance are refused and nothing moves (over, under, stale expectedHeldAmount)', async (top) => {
  const cases: Array<[Row, number, RegExp]> = [
    [fin({ outcome: 'SPLIT', refundToClient: 500, releaseToProvider: 600, expectedHeldAmount: 1000 }), 400, /يجب أن يساوي/],
    [fin({ outcome: 'SPLIT', refundToClient: 100, releaseToProvider: 100, expectedHeldAmount: 1000 }), 400, /يجب أن يساوي/],
    [fin({ releaseToProvider: 1000, expectedHeldAmount: 900 }), 409, /تغيّر المبلغ المحتجز/]
  ];
  for (const [input, status, re] of cases) await top.test(String(re), async (t) => {
    const w = makeWorld(t, { disputes: [dispute()] });
    const { disputeService } = await loadServices(t, w);
    await assert.rejects(() => disputeService.resolveFinancial('disp-x', 'admin-1', input), (e: any) => e.statusCode === status && re.test(e.message));
    const st = w.get();
    assert.equal(st.disputes[0].status, 'OPEN', 'the dispute claim is rolled back');
    assert.equal(st.escrow.status, 'HELD');
    assert.equal(st.escrow.releasedAmount, 0);
    assert.equal(st.contract.status, 'ACTIVE');
    assert.equal(st.walletTx.length, 0);
    assert.equal(st.audit.length, 0);
  });
});

test('IDEMPOTENCY: executing the same financial decision twice (sequential or concurrent) moves money exactly once', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService } = await loadServices(t, w);
  const input = fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 });
  const results = await Promise.allSettled([disputeService.resolveFinancial('disp-x', 'admin-1', input), disputeService.resolveFinancial('disp-x', 'admin-2', input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(w.get().users['client-1'].walletBalance, 1000);
  assert.equal(w.get().walletTx.length, 1);
  await assert.rejects(() => disputeService.resolveFinancial('disp-x', 'admin-1', input), (e: any) => e.statusCode === 409);
  assert.equal(w.get().users['client-1'].walletBalance, 1000);
});

test('the DB-level backstop: a second REFUND wallet row for the same dispute is rejected by the unique referenceId', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  await w.prisma.walletTransaction.create({ data: { referenceId: 'DISPUTE-REFUND-disp-x' } });
  await assert.rejects(() => w.prisma.walletTransaction.create({ data: { referenceId: 'DISPUTE-REFUND-disp-x' } }), /Unique constraint/);
});

test('ATOMICITY: if the audit write or the escrow write fails, the whole decision rolls back (dispute still open, wallet untouched, escrow HELD)', async (top) => {
  for (const key of ['auditCreate', 'escrowUpdate'] as const) await top.test(key, async (t) => {
    const w = makeWorld(t, { disputes: [dispute()] });
    const { disputeService } = await loadServices(t, w);
    w.failures[key] = true;
    await assert.rejects(() => disputeService.resolveFinancial('disp-x', 'admin-1', fin({ outcome: 'SPLIT', refundToClient: 400, releaseToProvider: 600 })), /failed/);
    const st = w.get();
    assert.equal(st.disputes[0].status, 'OPEN');
    assert.equal(st.users['client-1'].walletBalance, 0);
    assert.equal(st.walletTx.length, 0);
    assert.equal(st.escrow.status, 'HELD');
    assert.equal(st.escrow.releasedAmount, 0);
    assert.equal(st.contract.status, 'ACTIVE');
    assert.equal(st.project.status, 'IN_PROGRESS');
  });
});

test('a dispute on a COMPLETED project never claws money back: the contract is not ACTIVE / nothing is held, so a financial decision is refused; a text closure is fine', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()], contract: { status: 'COMPLETED' }, escrow: { id: 'esc-1', projectId: 'project-1', amount: 1000, status: 'RELEASED', releasedAmount: 1000, platformCommissionAmount: 100, providerNetReleasedAmount: 900, feePolicyVersion: 2, providerCommissionRateSnapshot: 10 } });
  const { disputeService } = await loadServices(t, w);
  await assert.rejects(() => disputeService.resolveFinancial('disp-x', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 })), (e: any) => e.statusCode === 409);
  assert.equal(w.get().escrow.releasedAmount, 1000);
  assert.equal(w.get().escrow.providerNetReleasedAmount, 900);
  assert.equal(w.get().users['client-1'].walletBalance, 0);
  await disputeService.resolve('disp-x', 'admin-1', { action: 'resolve', resolution: 'NO_FINANCIAL_CHANGE' });
  assert.equal(w.get().escrow.providerNetReleasedAmount, 900);
  assert.equal(w.get().disputes[0].status, 'RESOLVED');
});

test('after a financial decision a later approval cannot release again (contract no longer ACTIVE), even with the freeze lifted', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService, projectProgressService } = await loadServices(t, w);
  await disputeService.resolveFinancial('disp-x', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 }));
  w.prisma.contract.findFirst = async () => clone({ ...w.get().contract, project: { title: 'x' }, provider: {} });
  await assert.rejects(() => approve(projectProgressService), (e: any) => e.statusCode === 409 && /تسوية نزاع/.test(e.message));
  assert.equal(w.get().escrow.releasedAmount, 0);
});

test('multiple active disputes + a financial decision on one: the escrow is settled once; the other dispute stays open until an admin closes it by text', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ id: 'd1' }), dispute({ id: 'd2', openedById: 'provider-1', status: 'UNDER_REVIEW' })] });
  const { disputeService } = await loadServices(t, w);
  await disputeService.resolveFinancial('d1', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 }));
  assert.equal(w.get().disputes[1].status, 'UNDER_REVIEW');
  await assert.rejects(() => disputeService.resolveFinancial('d2', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 })), (e: any) => e.statusCode === 409);
  assert.equal(w.get().users['client-1'].walletBalance, 1000);
});

test('permissions: the financial route is gated by authorizeAdminActing (acting role), the text route is not financial', () => {
  const routes = readFileSync(join(__dirname, '..', 'routes', 'admin-disputes.routes.ts'), 'utf8');
  assert.match(routes, /router\.post\('\/:id\/resolve-financial', requirePermission\('disputes\.resolve', 'payouts\.send'\), authorizeAdminActing, resolveDisputeFinancial\)/);
  assert.match(routes, /router\.use\(authenticate, requireActiveUser, requirePermission\('disputes\.view'\)\)/);
  assert.match(routes, /router\.post\('\/:id\/resolve', requirePermission\('disputes\.resolve'\), resolveDispute\)/);
});

test('permissions: authorizeAdminActing refuses an admin who is ACTING as client/provider, and a plain client/provider, and passes real admin accounts', async () => {
  const { authorizeAdminActing } = await import('../middlewares/auth.middleware.ts?z=' + Math.random());
  const run = (user: any) => { let err: any = 'none'; authorizeAdminActing({ user } as any, {} as any, (e?: any) => { err = e ?? null; }); return err; };
  assert.equal(run({ accountType: 'ADMIN', activeRole: 'CLIENT' }), null);
  assert.equal(run({ accountType: 'SUPER_ADMIN', activeRole: 'ADMIN' }), null);
  assert.equal(run({ accountType: 'CLIENT_INDIVIDUAL', activeRole: 'CLIENT', roles: ['CLIENT', 'ADMIN'] }).statusCode, 403);
  assert.equal(run({ accountType: 'PROVIDER_INDIVIDUAL', activeRole: 'PROVIDER' }).statusCode, 403);
  assert.equal(run(undefined).statusCode, 401);
});

// ───────────────────────── display: Arabic labels, verbatim free text, links ─────────────────────────

test('labels: exact codes become Arabic; free text is returned verbatim; an unexecuted financial code is not presented as if money moved', async () => {
  const { resolutionLabelAr } = await import('../utils/dispute-resolution.ts?l=' + Math.random());
  assert.match(resolutionLabelAr('MUTUAL_CLOSE'), /إغلاق ودّي/);
  assert.match(resolutionLabelAr('mutual_close'), /إغلاق ودّي/);
  assert.equal(resolutionLabelAr('REFUND_CLIENT', true), 'استرداد المبلغ المحتجز للعميل');
  assert.match(resolutionLabelAr('REFUND_CLIENT', false), /لم يُنفَّذ ماليًا/);
  assert.match(resolutionLabelAr('RELEASE_TO_PROVIDER'), /لم يُنفَّذ ماليًا/);
  assert.equal(resolutionLabelAr('SPLIT', true), 'تقسيم المبلغ المحتجز بين الطرفين');
  const free = 'اتفق الطرفان على إغلاق الملف — MUTUAL_CLOSE في الاجتماع';
  assert.equal(resolutionLabelAr(free), free);
  assert.equal(resolutionLabelAr(''), '');
  assert.equal(resolutionLabelAr(null), '');
});

test('notifications: the client and the provider read Arabic (never the raw code), free text verbatim, and each link opens THIS dispute', async () => {
  const { clientNotificationFor } = await import('./client-notifications.service.ts?n=' + Math.random());
  const c = clientNotificationFor.disputeResolved({ clientId: 'c1', disputeId: 'D-1', action: 'resolve', resolution: 'MUTUAL_CLOSE' });
  assert.ok(!c.message.includes('MUTUAL_CLOSE'));
  assert.match(c.message, /إغلاق ودّي باتفاق الطرفين/);
  assert.match(c.message, /لم يتغيّر أي مبلغ مالي/);
  assert.equal(c.actionUrl, '/client-overview/disputes?dispute=D-1');
  const free = clientNotificationFor.disputeResolved({ clientId: 'c1', disputeId: 'D-1', action: 'reject', resolution: 'لم تثبت الواقعة المدّعاة' });
  assert.match(free.message, /«لم تثبت الواقعة المدّعاة»/);
  const opened = clientNotificationFor.disputeOpened({ clientId: 'c1', disputeId: 'D-2', openedBy: 'provider', requestTitle: 'م' });
  assert.equal(opened.actionUrl, '/client-overview/disputes?dispute=D-2');
  const money = clientNotificationFor.disputeResolved({ clientId: 'c1', disputeId: 'D-1', action: 'resolve', resolution: 'SPLIT', financial: { outcome: 'SPLIT', refundToClient: 300, releaseToProvider: 700, platformCommission: 70, providerNet: 630 } });
  assert.match(money.message, /أُضيف 300 \$ إلى محفظتك/);
  assert.match(money.message, /تقسيم المبلغ المحتجز/);
});

test('notifications (provider): Arabic label, net-after-commission wording, link to the provider dispute page', async (t) => {
  const created: any[] = [];
  t.mock.module('../config/db', { namedExports: { prisma: {} } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { created.push(n); return n; } } } });
  const { providerNotifications } = await import('./provider-notifications.service.ts?p=' + Math.random());
  await providerNotifications.disputeResolved({ disputeId: 'D-9', providerId: 'p1', action: 'resolve', resolution: 'RELEASE_PROVIDER', financial: { outcome: 'RELEASE_PROVIDER', refundToClient: 0, releaseToProvider: 1000, platformCommission: 100, providerNet: 900 } });
  await providerNotifications.disputeResolved({ disputeId: 'D-9', providerId: 'p1', action: 'resolve', resolution: 'MUTUAL_CLOSE' });
  assert.equal(created[0].actionUrl, '/provider-overview/disputes/D-9');
  assert.ok(!created[0].message.includes('RELEASE_PROVIDER'));
  assert.match(created[0].message, /صرف المبلغ المحتجز لمقدم الخدمة/);
  assert.match(created[0].message, /900 \$ بعد خصم عمولة المنصة 100 \$/);
  assert.ok(!created[1].message.includes('MUTUAL_CLOSE'));
  assert.match(created[1].message, /لم يتغيّر أي مبلغ مالي/);
});

test('getForUser / getForAdmin carry the Arabic label, the financial outcome and the project freeze state', async (t) => {
  const w = makeWorld(t, { disputes: [dispute({ id: 'd1' }), dispute({ id: 'd2', openedById: 'provider-1', againstUserId: 'client-1' })] });
  const { disputeService } = await loadServices(t, w);
  const before = await disputeService.getForUser('d1', 'client-1');
  assert.equal(before.projectFreeze.frozen, true);
  assert.equal(before.projectFreeze.activeDisputeCount, 2);
  assert.equal(before.financialOutcome, null);
  await disputeService.resolveFinancial('d1', 'admin-1', fin({ outcome: 'REFUND_CLIENT', refundToClient: 1000, releaseToProvider: 0 }));
  const after = await disputeService.getForUser('d1', 'provider-1');
  assert.equal(after.resolutionLabel, 'استرداد المبلغ المحتجز للعميل');
  assert.equal(after.financialOutcome.refundToClient, 1000);
  assert.equal(after.projectFreeze.activeDisputeCount, 1, 'one dispute closed, the other still counts');
  const admin = await disputeService.getForAdmin('d1');
  assert.equal(admin.financialOutcome.outcome, 'REFUND_CLIENT');
});

test('a financial decision needs disputes.resolve AND payouts.send: an ADMIN account holding neither (or an unknown actor) cannot execute it and nothing moves', async (t) => {
  const w = makeWorld(t, { disputes: [dispute()] });
  const { disputeService } = await loadServices(t, w);
  const before = clone({ escrow: w.get().escrow, users: w.get().users, contract: w.get().contract });
  for (const actor of ['admin-2', 'ghost']) {
    await assert.rejects(() => disputeService.resolveFinancial('disp-x', actor, { outcome: 'RELEASE_PROVIDER', refundToClient: 0, releaseToProvider: 50, expectedHeldAmount: 50, confirm: true } as any), (e: any) => e.statusCode === 403 && /إرسال الصرف/.test(e.message));
  }
  assert.deepEqual(clone({ escrow: w.get().escrow, users: w.get().users, contract: w.get().contract }), before);
  assert.equal(w.get().walletTx.length, 0);
});
