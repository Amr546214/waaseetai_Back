import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Client-side support-ticket flow (owner path): create, reply, close, list scoping,
// ownership checks and the notification deep link for client owners.

function makeFixture(status = 'OPEN', accountType = 'CLIENT_INDIVIDUAL') {
  const tickets: any[] = [{ id: 't1', ticketNumber: 'TK-ABC', userId: 'owner', status, resolvedAt: null, closedAt: null }];
  const messages: any[] = [];
  const notifications: any[] = [];
  const listWheres: any[] = [];
  const prisma = {
    user: { findUnique: async ({ where }: any) => ({ id: where.id, accountType }) },
    supportTicket: {
      findUnique: async ({ where }: any) => tickets.find(t => t.id === where.id) ?? null,
      findMany: async ({ where }: any) => { listWheres.push(where); return tickets.filter(t => t.userId === where.userId); },
      count: async () => 1,
      create: async ({ data }: any) => { const t = { id: 'new1', createdAt: new Date(), ...data }; tickets.push(t); return t; },
      update: async ({ where, data }: any) => { const t = tickets.find(x => x.id === where.id); Object.assign(t, data); return { ...t }; },
    },
    supportTicketMessage: {
      create: async ({ data }: any) => {
        const m = { id: `m${messages.length}`, createdAt: new Date(), ...data, sender: { id: data.senderId, firstName: 'C', lastName: 'L', accountType } };
        messages.push(m); return m;
      },
      findMany: async ({ where }: any) => messages.filter(m => m.ticketId === where.ticketId),
    },
  };
  return { tickets, messages, notifications, listWheres, prisma };
}

async function load(t: any, fx: ReturnType<typeof makeFixture>) {
  t.mock.module('../config/db', { namedExports: { prisma: fx.prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { fx.notifications.push(n); return n; } } } });
  const { supportTicketService } = await import(`./support-ticket.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return supportTicketService;
}

const input = { subject: 'مشكلة في الدفع', category: 'المحفظة والمدفوعات', description: 'وصف تفصيلي للمشكلة التي واجهتها', priority: 'عادية' };

for (const accountType of ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY']) {
  test(`creating a ticket seeds the thread and notifies the ${accountType} owner with the real client route`, async (t) => {
    const fx = makeFixture('OPEN', accountType);
    const svc = await load(t, fx);
    const ticket = await svc.create('owner', input as any);
    assert.equal(ticket.status, 'OPEN');
    assert.equal(fx.messages.length, 1);
    assert.equal(fx.messages[0].senderId, 'owner');
    assert.equal(fx.notifications.length, 1);
    assert.equal(fx.notifications[0].actionUrl, `/client-overview/help/tickets/${ticket.id}`);
    assert.equal(fx.notifications[0].type, 'SUPPORT_TICKET');
  });

  test(`staff reply and status change notify the ${accountType} owner with a client route`, async (t) => {
    const fx = makeFixture('OPEN', accountType);
    const svc = await load(t, fx);
    await svc.replyAsStaff('t1', 'staff', 'نراجع طلبك');
    await svc.setStatus('t1', 'RESOLVED');
    assert.deepEqual(fx.notifications.map(n => n.actionUrl), ['/client-overview/help/tickets/t1', '/client-overview/help/tickets/t1']);
    assert.deepEqual(fx.notifications.map(n => n.metadata.event), ['replied', 'status_changed']);
  });
}

test('client reply is stored and the staff message is visible with its sender accountType', async (t) => {
  const fx = makeFixture('AWAITING_CUSTOMER');
  const svc = await load(t, fx);
  await svc.replyAsStaff('t1', 'staff', 'سؤال من الدعم');
  const m = await svc.reply('t1', 'owner', 'ردّي');
  assert.equal(m.body, 'ردّي');
  assert.equal(fx.tickets[0].status, 'IN_PROGRESS');
  const detail = await svc.getForUser('t1', 'owner');
  assert.equal(detail.messages.length, 2);
});

test('a CLOSED ticket cannot be replied to by the owner (400) and cannot be closed twice (409)', async (t) => {
  const fx = makeFixture('CLOSED');
  const svc = await load(t, fx);
  await assert.rejects(() => svc.reply('t1', 'owner', 'x'), (e: any) => e.statusCode === 400);
  await assert.rejects(() => svc.close('t1', 'owner'), (e: any) => e.statusCode === 409);
});

test('another user cannot read, reply to or close the ticket (403) and a missing ticket is 404', async (t) => {
  const svc = await load(t, makeFixture('OPEN'));
  await assert.rejects(() => svc.getForUser('t1', 'intruder'), (e: any) => e.statusCode === 403);
  await assert.rejects(() => svc.reply('t1', 'intruder', 'x'), (e: any) => e.statusCode === 403);
  await assert.rejects(() => svc.close('t1', 'intruder'), (e: any) => e.statusCode === 403);
  await assert.rejects(() => svc.getForUser('nope', 'owner'), (e: any) => e.statusCode === 404);
});

test('the list is always scoped to the caller userId', async (t) => {
  const fx = makeFixture('OPEN');
  const svc = await load(t, fx);
  const r = await svc.listForUser('intruder');
  assert.equal(r.items.length, 0);
  assert.equal(fx.listWheres[0].userId, 'intruder');
});

test('the client tickets router requires authentication and an active user before every route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/client-tickets.routes.ts'), 'utf8');
  const guard = source.indexOf('router.use(requireActiveUser)');
  assert.ok(source.indexOf('router.use(authenticate)') > -1 && guard > -1);
  for (const r of ["router.post('/', ", "router.get('/', ", "router.get('/:id', ", "router.post('/:id/reply', ", "router.post('/:id/close', "]) {
    assert.ok(source.indexOf(r) > guard, r);
  }
});
