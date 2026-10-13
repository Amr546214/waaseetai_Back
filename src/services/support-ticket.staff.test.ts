import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Staff/admin support-ticket flow. The service is imported only after
// '../config/db' and './notification.service' are mocked (fresh import per test).

function makeFixture(status = 'OPEN', accountType = 'PROVIDER_INDIVIDUAL') {
  const ticket: any = { id: 't1', ticketNumber: 'TK-ABC', userId: 'owner', status, resolvedAt: null, closedAt: null };
  const messages: any[] = [{ id: 'm0', ticketId: 't1', senderId: 'owner', body: 'original', createdAt: new Date(1) }];
  const notifications: any[] = [];
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => where.id === 'owner'
        ? { id: 'owner', firstName: 'P', lastName: 'Q', email: 'p@x', accountType } : { id: where.id, accountType: 'ADMIN' },
    },
    supportTicket: {
      findUnique: async ({ where }: any) => (where.id === 't1' ? { ...ticket } : null),
      update: async ({ data }: any) => { Object.assign(ticket, data); return { ...ticket }; },
      create: async () => ticket,
    },
    supportTicketMessage: {
      create: async ({ data }: any) => {
        const m = { id: `m${messages.length}`, createdAt: new Date(), ...data, sender: { id: data.senderId, firstName: 'S', lastName: 'T', accountType: data.senderId === 'owner' ? accountType : 'ADMIN' } };
        messages.push(m); return m;
      },
      findMany: async () => messages.map(m => ({ ...m, sender: m.sender ?? { id: m.senderId, firstName: 'P', lastName: 'Q', accountType } })),
    },
  };
  return { ticket, messages, notifications, prisma };
}

async function load(t: any, fx: ReturnType<typeof makeFixture>) {
  t.mock.module('../config/db', { namedExports: { prisma: fx.prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { fx.notifications.push(n); return n; } } } });
  const { supportTicketService } = await import(`./support-ticket.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return supportTicketService;
}

test('staff reply is visible in the owner thread with sender info, moves OPEN -> AWAITING_CUSTOMER and notifies the provider', async (t) => {
  const fx = makeFixture('OPEN');
  const svc = await load(t, fx);
  const r = await svc.replyAsStaff('t1', 'staff', 'مرحبًا، نراجع طلبك');
  assert.equal(r.status, 'AWAITING_CUSTOMER');
  assert.equal(fx.ticket.status, 'AWAITING_CUSTOMER');
  const detail = await svc.getForUser('t1', 'owner');
  const last = detail.messages[detail.messages.length - 1];
  assert.equal(last.body, 'مرحبًا، نراجع طلبك');
  assert.equal(last.senderId, 'staff');
  assert.equal(last.sender.accountType, 'ADMIN');
  assert.equal(fx.notifications.length, 1);
  assert.equal(fx.notifications[0].userId, 'owner');
  assert.equal(fx.notifications[0].actionUrl, '/provider-overview/help/tickets/t1');
  assert.equal(fx.notifications[0].metadata.event, 'replied');
});

test('staff reply with an explicit status applies it; RESOLVED stamps resolvedAt', async (t) => {
  const fx = makeFixture('IN_PROGRESS');
  const svc = await load(t, fx);
  const r = await svc.replyAsStaff('t1', 'staff', 'تم الحل', 'RESOLVED');
  assert.equal(r.status, 'RESOLVED');
  assert.ok(fx.ticket.resolvedAt instanceof Date);
});

test('staff cannot reply to a CLOSED ticket (400) and unknown ticket is 404', async (t) => {
  const fx = makeFixture('CLOSED');
  const svc = await load(t, fx);
  await assert.rejects(() => svc.replyAsStaff('t1', 'staff', 'x'), (e: any) => e.statusCode === 400);
  await assert.rejects(() => svc.replyAsStaff('nope', 'staff', 'x'), (e: any) => e.statusCode === 404);
  await assert.rejects(() => svc.getForAdmin('nope'), (e: any) => e.statusCode === 404);
  await assert.rejects(() => svc.setStatus('nope', 'RESOLVED'), (e: any) => e.statusCode === 404);
});

test('status change is stored, visible to the owner, and notifies with the Arabic label', async (t) => {
  const fx = makeFixture('OPEN');
  const svc = await load(t, fx);
  await svc.setStatus('t1', 'IN_PROGRESS');
  const detail = await svc.getForUser('t1', 'owner');
  assert.equal(detail.ticket.status, 'IN_PROGRESS');
  assert.equal(fx.notifications.length, 1);
  assert.match(fx.notifications[0].message, /قيد المراجعة/);
  assert.equal(fx.notifications[0].metadata.event, 'status_changed');
  await svc.setStatus('t1', 'CLOSED');
  assert.ok(fx.ticket.closedAt instanceof Date);
  await svc.setStatus('t1', 'OPEN');
  assert.equal(fx.ticket.closedAt, null);
  await assert.rejects(() => svc.setStatus('t1', 'OPEN'), (e: any) => e.statusCode === 409);
});

test('owner reply moves AWAITING_CUSTOMER -> IN_PROGRESS and RESOLVED -> OPEN', async (t) => {
  const fx = makeFixture('AWAITING_CUSTOMER');
  const svc = await load(t, fx);
  await svc.reply('t1', 'owner', 'ردّي');
  assert.equal(fx.ticket.status, 'IN_PROGRESS');
  fx.ticket.status = 'RESOLVED';
  await svc.reply('t1', 'owner', 'ما زالت المشكلة');
  assert.equal(fx.ticket.status, 'OPEN');
});

test('a notification failure does not fail the staff reply', async (t) => {
  const fx = makeFixture('OPEN');
  t.mock.module('../config/db', { namedExports: { prisma: fx.prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async () => { throw new Error('boom'); } } } });
  const { supportTicketService: svc } = await import(`./support-ticket.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const r = await svc.replyAsStaff('t1', 'staff', 'hello');
  assert.equal(r.message.body, 'hello');
});

test('other users cannot read a ticket through the owner path (404, like a missing ticket)', async (t) => {
  const svc = await load(t, makeFixture('OPEN'));
  await assert.rejects(() => svc.getForUser('t1', 'someone-else'), (e: any) => e.statusCode === 404);
});

test('admin-tickets router is guarded by authenticate + requireActiveUser + authorize(ADMIN, SUPER_ADMIN) before every route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-tickets.routes.ts'), 'utf8');
  assert.match(source, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)\)/);
  const guard = source.indexOf('router.use(authenticate');
  for (const r of ["router.get('/', ", "router.get('/:id', ", "router.post('/:id/reply', ", "router.patch('/:id/status', "]) {
    assert.ok(source.indexOf(r) > guard, r);
  }
});

test('that guard rejects PROVIDER and CLIENT with 403 and unauthenticated with 401, allows ADMIN/SUPER_ADMIN', async () => {
  const { authorize } = await import('../middlewares/auth.middleware');
  const guard = authorize('ADMIN' as any, 'SUPER_ADMIN' as any);
  const run = (user: any) => { let err: any; guard({ user } as any, {} as any, (e?: any) => { err = e; }); return err; };
  for (const at of ['PROVIDER_INDIVIDUAL', 'CLIENT']) {
    const e = run({ accountType: at, roles: [at === 'CLIENT' ? 'CLIENT' : 'PROVIDER'], activeRole: at === 'CLIENT' ? 'CLIENT' : 'PROVIDER' });
    assert.equal(e?.statusCode, 403, at);
  }
  assert.equal(run(undefined)?.statusCode, 401);
  assert.equal(run({ accountType: 'ADMIN', roles: ['ADMIN'], activeRole: 'ADMIN' }), undefined);
  assert.equal(run({ accountType: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' }), undefined);
});
