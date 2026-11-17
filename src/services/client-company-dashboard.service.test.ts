import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function fixture(t: TestContext, accountType = 'CLIENT_COMPANY', empty = false) {
  const state = { accountType, empty };
  const reads: Array<{ name: string; args: any }> = [];
  const read = (name: string, result: unknown) => async (args: unknown) => { reads.push({ name, args }); return result; };
  t.mock.module('../config/db', { namedExports: { prisma: {
    user: { findUnique: async (args: any) => { reads.push({ name: 'user', args }); return { id: 'co-1', accountType: state.accountType, firstName: 'مالك', lastName: 'الشركة', walletBalance: 42.75, clientProfile: { companyName: 'شركة الاختبار', currentPoints: 25 } }; } },
    companyTeamMember: { count: async (args: any) => { reads.push({ name: 'employees', args }); return state.empty ? 0 : args.where.status ? 2 : 3; } },
    project: { count: async (args: any) => read('projectCount', state.empty ? 0 : 4)(args), findMany: async (args: any) => read('projectMembers', state.empty ? [] : [{ assignedEmployeeId: 'employee-1' }])(args) },
    projectStage: { aggregate: async (args: any) => read('spend', { _sum: { amount: state.empty ? null : 13.25 } })(args) }
  } } });
  t.mock.module('./gamification.service', { namedExports: { getClientLevelDetails: async () => ({ currentStats: { points: 25 }, currentLevel: { index: 1, title: 'مسوق' } }) } });
  const mod = await import(`./client-company-dashboard.service.ts?test=${Date.now()}-${Math.random()}`);
  return { get: mod.getClientCompanyDashboard, reads, state };
}

test('company dashboard', async t => {
  const { get, reads, state } = await fixture(t);
  await t.test('reads only the owner data and uses real totals without inventing budgets or approvals', async () => {
  const data = await get('co-1');
  assert.equal(data.companyName, 'شركة الاختبار');
  assert.equal(data.walletBalance, 42.75);
  assert.equal(data.kpis.activeEmployees, 2);
  assert.equal(data.kpis.activeEmployeesTotal, 3);
  assert.equal(data.kpis.activeTeamProjects, 4);
  assert.equal(data.kpis.activeTeamProjectsMembers, 1);
  assert.equal(data.kpis.quarterSpend, 13.25);
  assert.equal(data.kpis.remainingBudget, null);
  assert.equal(data.kpis.pendingYourApproval, null);
  assert.equal(data.quarterBudget, null);
  assert.deepEqual(data.pendingApprovals, []);
  assert.deepEqual(data.employeeSpending, []);
  for (const call of reads.filter(r => r.name === 'employees')) assert.equal(call.args.where.companyOwnerId, 'co-1');
  for (const call of reads.filter(r => r.name.startsWith('project'))) {
    assert.equal(call.args.where.clientId, 'co-1');
    assert.equal(call.args.where.assignedEmployee.is.companyOwnerId, 'co-1');
  }
  const spend = reads.find(r => r.name === 'spend')!.args.where;
  assert.equal(spend.contract.clientId, 'co-1');
  assert.equal(spend.status, 'APPROVED');
  assert.ok(spend.approvedAt.gte < spend.approvedAt.lt);
  });

  await t.test('empty companies have zero counts but unavailable metrics stay null', async () => {
  state.empty = true;
  const data = await get('co-1');
  assert.equal(data.kpis.activeEmployees, 0);
  assert.equal(data.kpis.activeTeamProjects, 0);
  assert.equal(data.kpis.quarterSpend, 0);
  assert.equal(data.quarterBudget, null);
  });

  await t.test('individual accounts cannot read company metrics', async () => {
  state.accountType = 'CLIENT_INDIVIDUAL'; reads.length = 0;
  await assert.rejects(() => get('co-1'), (error: any) => error.statusCode === 403);
  assert.equal(reads.length, 1);
  });
});
