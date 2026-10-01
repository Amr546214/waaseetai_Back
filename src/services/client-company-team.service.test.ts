import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { requireClientCompanyAccount } from '../routes/client-company-team.routes';
import { AccountType } from '@prisma/client';

// Batch 6 — real Client Company employee roster. This reuses the exact same
// CompanyTeamMember Prisma model/table the PROVIDER_COMPANY roster already
// uses (src/services/company-team.service.ts, UNMODIFIED) — companyOwnerId
// is a plain User.id FK with no accountType constraint at the DB level, so
// no migration was needed. These tests exercise that shared service through
// the CLIENT_COMPANY ownership path, plus the new route-level authorization
// guard and the controller's memberType-forcing behavior, since none of
// this had any test coverage before this batch.

function makeMember(overrides: any = {}) {
  return {
    id: 'member-1', companyOwnerId: 'client-co-1', name: 'سارة القحطاني', email: 'sara@client.sa',
    phone: null, jobTitle: 'مديرة المشتريات', memberType: 'EMPLOYEE', status: 'PENDING', avatarUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function loadService(t: TestContext, opts: { members?: any[] } = {}) {
  let store: any[] = opts.members ?? [];
  const prismaMock: any = {
    companyTeamMember: {
      create: async (args: any) => {
        if (store.some(m => m.companyOwnerId === args.data.companyOwnerId && m.email === args.data.email)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' });
        }
        const created = makeMember({ id: `m-${store.length + 1}`, ...args.data });
        store.push(created);
        return created;
      },
      findMany: async (args: any) => store.filter(m => m.companyOwnerId === args.where.companyOwnerId),
      findFirst: async (args: any) => store.find(m => m.id === args.where.id && m.companyOwnerId === args.where.companyOwnerId) ?? null,
      update: async (args: any) => {
        const idx = store.findIndex(m => m.id === args.where.id);
        store[idx] = { ...store[idx], ...args.data };
        return store[idx];
      },
      deleteMany: async (args: any) => {
        const before = store.length;
        store = store.filter(m => !(m.id === args.where.id && m.companyOwnerId === args.where.companyOwnerId));
        return { count: before - store.length };
      },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const moduleUrl = `./company-team.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { service: mod.companyTeamService as any, getStore: () => store };
}

test('a company sees only its own employees — list scoped by companyOwnerId', async t => {
  const { service } = await loadService(t, {
    members: [
      makeMember({ id: 'm1', companyOwnerId: 'client-co-1', name: 'موظف الشركة الأولى' }),
      makeMember({ id: 'm2', companyOwnerId: 'client-co-2', name: 'موظف الشركة الثانية' }),
    ],
  });
  const result = await service.list('client-co-1');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'موظف الشركة الأولى');
});

test('empty state: a company with zero employees gets an empty array, never fabricated rows', async t => {
  const { service } = await loadService(t, { members: [] });
  const result = await service.list('client-co-1');
  assert.deepEqual(result, []);
});

test('other company data denied: get() for a real member id under a different companyOwnerId returns not-found, not the other company\'s row', async t => {
  const { service } = await loadService(t, { members: [makeMember({ id: 'm1', companyOwnerId: 'client-co-1' })] });
  await assert.rejects(() => service.get('client-co-2', 'm1'), /غير موجود/);
});

test('cross-company assignment rejected: update() under a different companyOwnerId is rejected as not-found, never silently mutates another company\'s row', async t => {
  const { service, getStore } = await loadService(t, { members: [makeMember({ id: 'm1', companyOwnerId: 'client-co-1', name: 'الاسم الأصلي' })] });
  await assert.rejects(() => service.update('client-co-2', 'm1', { name: 'محاولة تعديل من شركة أخرى' }));
  assert.equal(getStore()[0].name, 'الاسم الأصلي');
});

test('cross-company removal rejected: remove() under a different companyOwnerId is rejected, row survives', async t => {
  const { service, getStore } = await loadService(t, { members: [makeMember({ id: 'm1', companyOwnerId: 'client-co-1' })] });
  await assert.rejects(() => service.remove('client-co-2', 'm1'));
  assert.equal(getStore().length, 1);
});

test('nonexistent member id is rejected for the owning company too', async t => {
  const { service } = await loadService(t, { members: [] });
  await assert.rejects(() => service.get('client-co-1', 'does-not-exist'), /غير موجود/);
});

test('duplicate assignment rejected: creating a second employee with the same email for the same company is rejected (409-style)', async t => {
  const { service } = await loadService(t, { members: [makeMember({ companyOwnerId: 'client-co-1', email: 'dup@client.sa' })] });
  await assert.rejects(
    () => service.create('client-co-1', { name: 'شخص آخر', email: 'dup@client.sa', jobTitle: 'موظف', memberType: 'EMPLOYEE' }),
    /بريد/
  );
});

test('the same email IS allowed across two different companies (uniqueness is per-company, not global)', async t => {
  const { service } = await loadService(t, { members: [makeMember({ companyOwnerId: 'client-co-1', email: 'shared@x.sa' })] });
  const created = await service.create('client-co-2', { name: 'موظف شركة أخرى', email: 'shared@x.sa', jobTitle: 'موظف', memberType: 'EMPLOYEE' });
  assert.equal(created.email, 'shared@x.sa');
});

test('a valid create for the owning company succeeds and returns the real created record', async t => {
  const { service } = await loadService(t, { members: [] });
  const created = await service.create('client-co-1', { name: 'موظف جديد', email: 'new@client.sa', jobTitle: 'محاسب', memberType: 'EMPLOYEE' });
  assert.equal(created.name, 'موظف جديد');
  assert.equal(created.status, 'PENDING');
});

test('a valid update for the owning company succeeds', async t => {
  const { service } = await loadService(t, { members: [makeMember({ id: 'm1', companyOwnerId: 'client-co-1', status: 'PENDING' })] });
  const updated = await service.update('client-co-1', 'm1', { status: 'ACTIVE' });
  assert.equal(updated.status, 'ACTIVE');
});

test('the formatted response never leaks companyOwnerId (not required by any UI, would reveal the owning account id)', async t => {
  const { service } = await loadService(t, { members: [makeMember({ id: 'm1', companyOwnerId: 'client-co-1' })] });
  const result = await service.get('client-co-1', 'm1');
  assert.ok(!('companyOwnerId' in result));
});

test('no N+1: list() issues exactly one findMany query regardless of row count', async t => {
  let findManyCalls = 0;
  const members = Array.from({ length: 5 }, (_, i) => makeMember({ id: `m${i}`, companyOwnerId: 'client-co-1' }));
  const prismaMock: any = {
    companyTeamMember: {
      findMany: async (args: any) => { findManyCalls++; return members.filter(m => m.companyOwnerId === args.where.companyOwnerId); },
    },
  };
  t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
  const mod = await import(`./company-team.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const result = await mod.companyTeamService.list('client-co-1');
  assert.equal(result.length, 5);
  assert.equal(findManyCalls, 1);
});

// Route-level authorization guard (requireClientCompanyAccount) — unit
// tested directly since it is now exported, proving CLIENT_INDIVIDUAL,
// PROVIDER and MARKETING_BROKER accounts are all denied before any service
// call is reached.
test('requireClientCompanyAccount allows a CLIENT_COMPANY request through', () => {
  let nextArg: any = 'not-called';
  requireClientCompanyAccount({ user: { accountType: AccountType.CLIENT_COMPANY } } as any, {} as any, (arg?: any) => { nextArg = arg; });
  assert.equal(nextArg, undefined);
});

test('requireClientCompanyAccount denies CLIENT_INDIVIDUAL with a 403 AppError', () => {
  let nextArg: any;
  requireClientCompanyAccount({ user: { accountType: AccountType.CLIENT_INDIVIDUAL } } as any, {} as any, (arg?: any) => { nextArg = arg; });
  assert.ok(nextArg);
  assert.equal(nextArg.statusCode, 403);
});

test('requireClientCompanyAccount denies PROVIDER_COMPANY (a provider\'s roster is a completely separate feature)', () => {
  let nextArg: any;
  requireClientCompanyAccount({ user: { accountType: AccountType.PROVIDER_COMPANY } } as any, {} as any, (arg?: any) => { nextArg = arg; });
  assert.ok(nextArg);
  assert.equal(nextArg.statusCode, 403);
});

test('requireClientCompanyAccount denies MARKETING_BROKER', () => {
  let nextArg: any;
  requireClientCompanyAccount({ user: { accountType: AccountType.MARKETING_BROKER } } as any, {} as any, (arg?: any) => { nextArg = arg; });
  assert.ok(nextArg);
  assert.equal(nextArg.statusCode, 403);
});

// Controller: memberType is never client-controlled on this endpoint.
// Mocks the service itself (not prisma) to isolate the controller's own
// "always force EMPLOYEE" logic from the shared service's create() logic,
// which is already covered by the service-level tests above.
test('createClientTeamMember forces memberType to EMPLOYEE even if the client sends memberType: "PROVIDER" in the body', async t => {
  let createCallInput: any;
  const serviceMock = {
    companyTeamService: {
      create: async (companyOwnerId: string, input: any) => { createCallInput = input; return { id: 'm1', ...input }; },
    },
  };
  t.mock.module('../services/company-team.service', { namedExports: serviceMock });
  const controllerMod = await import(`../controllers/client-company-team.controller.ts?fixture=${Date.now()}-${Math.random()}`);

  let jsonBody: any;
  const req: any = { user: { id: 'client-co-1' }, body: { name: 'موظف', email: 'e@x.sa', jobTitle: 'منصب', memberType: 'PROVIDER' } };
  const res: any = { status: () => res, json: (b: any) => { jsonBody = b; } };
  await controllerMod.createClientTeamMember(req, res, (e: any) => { throw e; });

  assert.equal(createCallInput.memberType, 'EMPLOYEE');
  assert.equal(jsonBody.data.memberType, 'EMPLOYEE');
});

test('updateClientTeamMember also forces memberType to EMPLOYEE, never trusting the client body', async t => {
  let updateCallInput: any;
  const serviceMock = {
    companyTeamService: {
      update: async (companyOwnerId: string, id: string, input: any) => { updateCallInput = input; return { id, ...input }; },
    },
  };
  t.mock.module('../services/company-team.service', { namedExports: serviceMock });
  const controllerMod = await import(`../controllers/client-company-team.controller.ts?fixture=${Date.now()}-${Math.random()}`);

  const req: any = { user: { id: 'client-co-1' }, params: { id: 'm1' }, body: { status: 'ACTIVE', memberType: 'PROVIDER' } };
  const res: any = { json: () => {} };
  await controllerMod.updateClientTeamMember(req, res, (e: any) => { throw e; });

  assert.equal(updateCallInput.memberType, 'EMPLOYEE');
});
