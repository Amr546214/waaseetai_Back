import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Batch 6 — Project.assignedEmployeeId: the Client Company "responsible
// employee" who monitors/follows up on a project (never executes Provider
// work, has no WaseetAI login). These tests exercise
// ClientProjectAssignmentService.setAssignedEmployee() against a mocked
// prisma, proving ownership isolation on BOTH sides (project AND employee),
// eligibility rules (ACTIVE + EMPLOYEE only), and audit logging.

function makeProject(overrides: any = {}) {
  return { id: 'proj-1', clientId: 'company-1', assignedEmployeeId: null, ...overrides };
}
function makeMember(overrides: any = {}) {
  return { id: 'emp-1', companyOwnerId: 'company-1', memberType: 'EMPLOYEE', status: 'ACTIVE', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات', ...overrides };
}

async function loadService(t: TestContext, opts: { projects?: any[]; members?: any[] } = {}) {
  const projects: any[] = opts.projects ?? [];
  const members: any[] = opts.members ?? [];
  const auditCalls: any[] = [];
  const prismaMock: any = {
    project: {
      findFirst: async (args: any) => projects.find(p => p.id === args.where.id && p.clientId === args.where.clientId) ?? null,
      update: async (args: any) => {
        const idx = projects.findIndex(p => p.id === args.where.id);
        projects[idx] = { ...projects[idx], assignedEmployeeId: args.data.assignedEmployeeId };
        const employee = args.data.assignedEmployeeId ? members.find(m => m.id === args.data.assignedEmployeeId) : null;
        return { ...projects[idx], assignedEmployee: employee ? { id: employee.id, name: employee.name, jobTitle: employee.jobTitle } : null };
      },
    },
    companyTeamMember: {
      findFirst: async (args: any) => members.find(m =>
        m.id === args.where.id &&
        m.companyOwnerId === args.where.companyOwnerId &&
        m.memberType === args.where.memberType &&
        m.status === args.where.status
      ) ?? null,
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', {
    namedExports: {
      accountAuditLogService: { record: async (input: any) => { auditCalls.push(input); return {}; } },
    },
  });
  const moduleUrl = `./client-project-assignment.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.clientProjectAssignmentService as { setAssignedEmployee: (companyUserId: string, projectId: string, employeeId: string | null) => Promise<any> }, getProjects: () => projects, auditCalls };
}

test('1) own-company assignment succeeds and returns the real assignee', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember()] });
  const result = await service.setAssignedEmployee('company-1', 'proj-1', 'emp-1');
  assert.deepEqual(result.employee, { id: 'emp-1', name: 'سارة القحطاني', jobTitle: 'مديرة المشتريات' });
});

test('2) cross-company employee rejected — employeeId belongs to a different company', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember({ companyOwnerId: 'company-2' })] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'emp-1'), /غير متاح للتعيين/);
});

test('3) cross-client project rejected — project belongs to a different client', async t => {
  const { service } = await loadService(t, { projects: [makeProject({ clientId: 'company-2' })], members: [makeMember()] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'emp-1'), /غير موجود/);
});

test('4) an employee can own multiple project assignments', async t => {
  const { service } = await loadService(t, {
    projects: [makeProject({ id: 'proj-1' }), makeProject({ id: 'proj-2' })],
    members: [makeMember()],
  });
  const r1 = await service.setAssignedEmployee('company-1', 'proj-1', 'emp-1');
  const r2 = await service.setAssignedEmployee('company-1', 'proj-2', 'emp-1');
  assert.equal(r1.employee.id, 'emp-1');
  assert.equal(r2.employee.id, 'emp-1');
});

test('5) reassignment overwrites correctly', async t => {
  const { service } = await loadService(t, {
    projects: [makeProject({ assignedEmployeeId: 'emp-1' })],
    members: [makeMember({ id: 'emp-1' }), makeMember({ id: 'emp-2', name: 'خالد العتيبي' })],
  });
  const result = await service.setAssignedEmployee('company-1', 'proj-1', 'emp-2');
  assert.equal(result.employee.id, 'emp-2');
});

test('6) INACTIVE employee rejected', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember({ status: 'INACTIVE' })] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'emp-1'), /غير متاح للتعيين/);
});

test('7) PENDING employee rejected', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember({ status: 'PENDING' })] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'emp-1'), /غير متاح للتعيين/);
});

test('8) nonexistent employee rejected', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'does-not-exist'), /غير متاح للتعيين/);
});

test('9) PROVIDER memberType rejected (defense-in-depth — the shared table could theoretically hold a provider-type row under this companyOwnerId)', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember({ memberType: 'PROVIDER' })] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'proj-1', 'emp-1'), /غير متاح للتعيين/);
});

test('13) employeeId = null unassigns successfully', async t => {
  const { service } = await loadService(t, { projects: [makeProject({ assignedEmployeeId: 'emp-1' })], members: [makeMember()] });
  const result = await service.setAssignedEmployee('company-1', 'proj-1', null);
  assert.equal(result.employee, null);
});

test('15) a project with no assignment returns employee: null, never a fabricated name', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [] });
  const result = await service.setAssignedEmployee('company-1', 'proj-1', null);
  assert.equal(result.employee, null);
});

test('19) the response never leaks companyOwnerId or other roster-internal fields', async t => {
  const { service } = await loadService(t, { projects: [makeProject()], members: [makeMember()] });
  const result = await service.setAssignedEmployee('company-1', 'proj-1', 'emp-1');
  assert.deepEqual(Object.keys(result.employee).sort(), ['id', 'jobTitle', 'name']);
});

test('20) nonexistent project id behaves identically to not-owned (IDOR-safe — no information leak about whether the id exists at all)', async t => {
  const { service } = await loadService(t, { projects: [], members: [makeMember()] });
  await assert.rejects(() => service.setAssignedEmployee('company-1', 'does-not-exist', 'emp-1'), /غير موجود/);
});

// Audit log coverage
test('audit log: a fresh assignment records a PROJECT_EMPLOYEE_ASSIGNED event with only non-sensitive ids', async t => {
  const { service, auditCalls } = await loadService(t, { projects: [makeProject()], members: [makeMember()] });
  await service.setAssignedEmployee('company-1', 'proj-1', 'emp-1');
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].eventType, 'PROJECT_EMPLOYEE_ASSIGNED');
  assert.equal(auditCalls[0].userId, 'company-1');
  assert.deepEqual(auditCalls[0].after, { employeeId: 'emp-1' });
  assert.deepEqual(auditCalls[0].before, { employeeId: null });
});

test('audit log: changing an existing assignment records PROJECT_EMPLOYEE_REASSIGNED', async t => {
  const { service, auditCalls } = await loadService(t, {
    projects: [makeProject({ assignedEmployeeId: 'emp-1' })],
    members: [makeMember({ id: 'emp-1' }), makeMember({ id: 'emp-2' })],
  });
  await service.setAssignedEmployee('company-1', 'proj-1', 'emp-2');
  assert.equal(auditCalls[0].eventType, 'PROJECT_EMPLOYEE_REASSIGNED');
});

test('audit log: unassigning records PROJECT_EMPLOYEE_UNASSIGNED', async t => {
  const { service, auditCalls } = await loadService(t, {
    projects: [makeProject({ assignedEmployeeId: 'emp-1' })],
    members: [makeMember()],
  });
  await service.setAssignedEmployee('company-1', 'proj-1', null);
  assert.equal(auditCalls[0].eventType, 'PROJECT_EMPLOYEE_UNASSIGNED');
});

test('audit log: a failing audit write never blocks or fails the real assignment', async t => {
  const projects = [makeProject()];
  const members = [makeMember()];
  const prismaMock: any = {
    project: {
      findFirst: async (args: any) => projects.find(p => p.id === args.where.id && p.clientId === args.where.clientId) ?? null,
      update: async (args: any) => {
        const idx = projects.findIndex(p => p.id === args.where.id);
        projects[idx] = { ...projects[idx], assignedEmployeeId: args.data.assignedEmployeeId };
        const employee = members.find(m => m.id === args.data.assignedEmployeeId);
        return { ...projects[idx], assignedEmployee: employee ? { id: employee.id, name: employee.name, jobTitle: employee.jobTitle } : null };
      },
    },
    companyTeamMember: {
      findFirst: async (args: any) => members.find(m => m.id === args.where.id && m.companyOwnerId === args.where.companyOwnerId) ?? null,
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  t.mock.module('./account-logs.service', {
    namedExports: { accountAuditLogService: { record: async () => { throw new Error('audit db down'); } } },
  });
  const mod = await import(`./client-project-assignment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const result = await mod.clientProjectAssignmentService.setAssignedEmployee('company-1', 'proj-1', 'emp-1');
  assert.equal(result.employee.id, 'emp-1');
});
