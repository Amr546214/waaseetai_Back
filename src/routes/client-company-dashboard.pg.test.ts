import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const url = process.env.QA_ISOLATED_PG_URL;
const enabled = !!url && url === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\/qa_/.test(url);
const opts = { skip: enabled ? false : 'requires disposable local QA PostgreSQL on :55432' };
let prisma: any;
let server: http.Server | undefined;
let base = '';
const tokens: Record<string, string> = {};
let otherId = '';

before(async () => {
  if (!enabled) return;
  process.env.JWT_SECRET = 'company-dashboard-isolated-test-secret';
  ({ prisma } = await import('../config/db'));
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const route = (await import('./client-company-dashboard.routes')).default;
  const { globalErrorHandler } = await import('../middlewares/error.middleware');
  const createUser = async (key: string, accountType = 'CLIENT_COMPANY', activeRole = 'CLIENT', status = 'ACTIVE') => {
    const user = await prisma.user.create({ data: {
      id: randomUUID(), email: `${randomUUID()}@pg.test`, firstName: 'QA', lastName: key,
      accountType, activeRole, status, roles: ['CLIENT', ...(activeRole === 'PROVIDER' ? ['PROVIDER'] : [])],
      walletBalance: key === 'own' ? 88.5 : 999,
      clientProfile: { create: { companyName: `شركة ${key}` } }
    } });
    tokens[key] = jwt.sign({ userId: user.id, accountType, activeRole }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    return user;
  };
  const own = await createUser('own');
  const other = await createUser('other'); otherId = other.id;
  await createUser('individual', 'CLIENT_INDIVIDUAL');
  await createUser('wrong-role', 'CLIENT_COMPANY', 'PROVIDER');
  await createUser('suspended', 'CLIENT_COMPANY', 'CLIENT', 'SUSPENDED');
  const provider = await prisma.user.create({ data: { accountType: 'PROVIDER_INDIVIDUAL', firstName: 'QA', lastName: 'Provider', email: `${randomUUID()}@pg.test`, status: 'ACTIVE' } });
  const member = await prisma.companyTeamMember.create({ data: { companyOwnerId: own.id, name: 'موظف الشركة', email: `${randomUUID()}@pg.test`, jobTitle: 'متابعة', memberType: 'EMPLOYEE', status: 'ACTIVE' } });
  await prisma.companyTeamMember.create({ data: { companyOwnerId: other.id, name: 'موظف آخر', email: `${randomUUID()}@pg.test`, jobTitle: 'متابعة', memberType: 'EMPLOYEE', status: 'ACTIVE' } });
  const project = await prisma.project.create({ data: { title: 'مشروع اختبار', description: 'synthetic', specialty: 'test', deliveryDays: 5, clientId: own.id, providerId: provider.id, assignedEmployeeId: member.id, status: 'IN_PROGRESS' } });
  await prisma.contract.create({ data: { projectId: project.id, clientId: own.id, providerId: provider.id, price: 25, durationDays: 5, status: 'ACTIVE', stages: { create: { stepOrder: 1, title: 'مرحلة معتمدة', days: 5, percentage: 100, amount: 25, status: 'APPROVED', approvedAt: new Date() } } } });
  const app = express(); app.use('/api/client/company', route); app.use(globalErrorHandler as any);
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/client/company/dashboard`;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await prisma?.$disconnect();
});
const get = (key?: string, query = '') => fetch(base + query, { headers: key ? { Authorization: `Bearer ${tokens[key] ?? key}` } : {} });

test('real HTTP + JWT + PostgreSQL: company summary uses only the session owner, including a spoofed query id', opts, async () => {
  const response = await get('own', `?userId=${otherId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body: any = await response.json();
  assert.equal(body.data.companyName, 'شركة own');
  assert.equal(body.data.walletBalance, 88.5);
  assert.equal(body.data.kpis.activeEmployees, 1);
  assert.equal(body.data.kpis.activeTeamProjects, 1);
  assert.equal(body.data.kpis.quarterSpend, 25);
  assert.equal(body.data.quarterBudget, null);
  assert.equal(body.data.kpis.pendingYourApproval, null);
});
test('company dashboard rejects missing and forged credentials', opts, async () => {
  assert.equal((await get()).status, 401);
  assert.equal((await get('invalid-token')).status, 401);
});
test('company dashboard rejects individual, inactive and wrong-active-role identities', opts, async () => {
  for (const key of ['individual', 'suspended', 'wrong-role']) assert.equal((await get(key)).status, 403, key);
});
test('a second company sees its own wallet and empty projects, never the first company summary', opts, async () => {
  const response = await get('other');
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.equal(body.data.walletBalance, 999);
  assert.equal(body.data.kpis.activeTeamProjects, 0);
  assert.equal(body.data.kpis.quarterSpend, 0);
});
