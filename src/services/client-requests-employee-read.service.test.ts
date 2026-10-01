import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Batch 6 — real-employee read contract on the CANONICAL existing Client
// project list (getActiveProjects) and workspace detail (getProjectProgress)
// endpoints — no parallel "employee projects" backend was built. These
// prove: the employee field resolves in the SAME batched query (no N+1),
// ?employeeId filtering is ownership-validated, existing fields are
// unaffected, and Client Individual (no CompanyTeamMember concept) behavior
// is unchanged.

function project(overrides: any = {}) {
  return {
    id: 'proj-1', title: 'مشروع تجريبي', clientId: 'company-1', status: 'IN_PROGRESS',
    deliveryDays: 10, updatedAt: new Date('2026-01-01T00:00:00Z'),
    projectProposals: [], proposals: [], escrow: null, contract: null,
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: { projects?: any[]; clientRequests?: any[]; members?: any[]; hasClientProfile?: boolean } = {}) {
  const projects = opts.projects ?? [];
  const clientRequests = opts.clientRequests ?? [];
  const members = opts.members ?? [];
  const findManyCalls: any[] = [];
  const prismaMock: any = {
    clientProfile: { findUnique: async () => (opts.hasClientProfile === false ? null : { id: 'cp-1', userId: 'company-1' }) },
    companyTeamMember: {
      findFirst: async (args: any) => members.find(m => m.id === args.where.id && m.companyOwnerId === args.where.companyOwnerId) ?? null,
    },
    clientRequest: { findMany: async () => clientRequests },
    project: {
      findMany: async (args: any) => {
        findManyCalls.push(args);
        // The main `clientId`-scoped query vs. the later batched
        // `assignedEmployeeId`-select employee-resolution query are
        // distinguished by their where-shape.
        if (args.where?.clientId) return projects;
        if (args.where?.id?.in) {
          return projects
            .filter(p => args.where.id.in.includes(p.id) && p.assignedEmployeeId)
            .map(p => ({ id: p.id, assignedEmployee: members.find(m => m.id === p.assignedEmployeeId) || null }));
        }
        return [];
      },
    },
    escrow: { findMany: async () => [] },
    contract: { findMany: async () => [] },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./client-requests.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { service: mod.clientRequestsService as any, findManyCalls };
}

test('employee field resolves for a Project-primary active item', async t => {
  const { service } = await loadService(t, {
    projects: [project({ id: 'p1', assignedEmployeeId: 'emp-1' })],
    members: [{ id: 'emp-1', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات' }],
  });
  const result = await service.getActiveProjects('company-1');
  assert.deepEqual(result.projects[0].employee, { id: 'emp-1', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات' });
});

test('employee: null for an unassigned project — never fabricated', async t => {
  const { service } = await loadService(t, { projects: [project({ id: 'p1', assignedEmployeeId: null })] });
  const result = await service.getActiveProjects('company-1');
  assert.equal(result.projects[0].employee, null);
});

test('employeeId filter scopes the list to only that employee\'s own projects', async t => {
  const { service } = await loadService(t, {
    projects: [
      project({ id: 'p1', assignedEmployeeId: 'emp-1' }),
      project({ id: 'p2', assignedEmployeeId: 'emp-2' }),
    ],
    members: [
      { id: 'emp-1', companyOwnerId: 'company-1', name: 'سارة', jobTitle: 'مديرة' },
      { id: 'emp-2', companyOwnerId: 'company-1', name: 'خالد', jobTitle: 'محاسب' },
    ],
  });
  const result = await service.getActiveProjects('company-1', 'emp-1');
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].id, 'p1');
});

test('a foreign employeeId (not owned by the caller) is rejected outright, never used as a filter', async t => {
  const { service } = await loadService(t, {
    projects: [project({ id: 'p1' })],
    members: [{ id: 'emp-x', companyOwnerId: 'some-other-company', name: 'شخص آخر', jobTitle: 'منصب' }],
  });
  await assert.rejects(() => service.getActiveProjects('company-1', 'emp-x'), /غير موجود ضمن فريق شركتك/);
});

test('no N+1: the employee field is resolved via exactly one extra batched project.findMany call, not per-row', async t => {
  const { service, findManyCalls } = await loadService(t, {
    projects: [
      project({ id: 'p1', assignedEmployeeId: 'emp-1' }),
      project({ id: 'p2', assignedEmployeeId: 'emp-1' }),
      project({ id: 'p3', assignedEmployeeId: null }),
    ],
    members: [{ id: 'emp-1', name: 'سارة', jobTitle: 'مديرة' }],
  });
  await service.getActiveProjects('company-1');
  // Exactly 2 project.findMany calls total: the primary clientId-scoped
  // query, and the one batched employee-resolution query — never 3 (one per
  // assigned row).
  assert.equal(findManyCalls.length, 2);
});

test('existing response fields remain unchanged alongside the new employee field', async t => {
  const { service } = await loadService(t, { projects: [project({ id: 'p1', title: 'عنوان حقيقي', deliveryDays: 20 })] });
  const result = await service.getActiveProjects('company-1');
  const item = result.projects[0];
  assert.equal(item.id, 'p1');
  assert.equal(item.title, 'عنوان حقيقي');
  assert.ok('employee' in item);
  assert.ok('kpis' in result || Array.isArray(result.kpis));
});

test('a Client Individual (no ClientProfile-backed company context, no employeeId ever passed) still gets a normal project list with employee: null throughout', async t => {
  const { service } = await loadService(t, { projects: [project({ id: 'p1', assignedEmployeeId: null })], hasClientProfile: false });
  const result = await service.getActiveProjects('individual-1');
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].employee, null);
});

// getProjectProgress (the real canonical workspace/detail endpoint behind
// /client-overview/projects/:id) — pre-contract fallback branch, which only
// needs project.findFirst to exercise the new assignedEmployee include.
async function loadProgressService(t: TestContext, opts: { project: any }) {
  const prismaMock: any = {
    contract: { findFirst: async () => null },
    project: { findFirst: async (args: any) => (args.where.id === opts.project.id && args.where.clientId === opts.project.clientId ? opts.project : null) },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./project-progress.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return mod.projectProgressService as any;
}

test('getProjectProgress (pre-contract branch): real assignedEmployee resolves to the employee field', async t => {
  const svc = await loadProgressService(t, {
    project: {
      id: 'proj-1', clientId: 'company-1', title: 'مشروع', deliveryDays: 10, updatedAt: new Date(),
      escrow: null, proposals: [], assignedEmployee: { id: 'emp-1', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات' },
    },
  });
  const result = await svc.getProjectProgress('company-1', 'proj-1');
  assert.deepEqual(result.employee, { id: 'emp-1', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات' });
});

test('getProjectProgress (pre-contract branch): no assignment returns employee: null, never fabricated', async t => {
  const svc = await loadProgressService(t, {
    project: { id: 'proj-1', clientId: 'company-1', title: 'مشروع', deliveryDays: 10, updatedAt: new Date(), escrow: null, proposals: [], assignedEmployee: null },
  });
  const result = await svc.getProjectProgress('company-1', 'proj-1');
  assert.equal(result.employee, null);
});
