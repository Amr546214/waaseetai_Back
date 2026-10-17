import { test } from 'node:test';
import assert from 'node:assert/strict';

// Marketer support tickets reuse the role-agnostic ticket system: create / list / detail / reply / admin reply visible / status / someone else's ticket = 404,
// and the ticket notifications of a marketer open the REAL marketer ticket page (angular-app marketer.routes.ts: help/tickets/:id).

function makeFixture(status = 'OPEN') {
  const ticket: any = { id: 't1', ticketNumber: 'TK-ABC', userId: 'mkt', status, resolvedAt: null, closedAt: null };
  const messages: any[] = [{ id: 'm0', ticketId: 't1', senderId: 'mkt', body: 'original', createdAt: new Date(1) }];
  const notifications: any[] = [];
  const created: any[] = [];
  const prisma = {
    user: { findUnique: async ({ where }: any) => (where.id === 'mkt' ? { id: 'mkt', accountType: 'MARKETING_BROKER' } : { id: where.id, accountType: 'ADMIN' }) },
    supportTicket: {
      findUnique: async ({ where }: any) => (where.id === 't1' ? { ...ticket } : null),
      update: async ({ data }: any) => { Object.assign(ticket, data); return { ...ticket }; },
      create: async ({ data }: any) => { created.push(data); return { ...ticket, ...data, id: 't1' }; },
      findMany: async ({ where }: any) => (where.userId === 'mkt' ? [{ ...ticket }] : []),
      count: async ({ where }: any) => (where.userId === 'mkt' ? 1 : 0),
    },
    supportTicketMessage: {
      create: async ({ data }: any) => { const m = { id: `m${messages.length}`, createdAt: new Date(), ...data, sender: { id: data.senderId, firstName: 'S', lastName: 'T', accountType: data.senderId === 'mkt' ? 'MARKETING_BROKER' : 'ADMIN' } }; messages.push(m); return m; },
      findMany: async () => messages.map(m => ({ ...m, sender: m.sender ?? { id: m.senderId, firstName: 'L', lastName: 'M', accountType: 'MARKETING_BROKER' } })),
    },
  };
  return { ticket, messages, notifications, created, prisma };
}

async function load(t: any, fx: ReturnType<typeof makeFixture>) {
  t.mock.module('../config/db', { namedExports: { prisma: fx.prisma } });
  t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async (n: any) => { fx.notifications.push(n); return n; } } } });
  return (await import(`./support-ticket.service.ts?fixture=${Date.now()}-${Math.random()}`)).supportTicketService;
}

const REAL_MARKETER_TICKET_ROUTE = /^\/marketer-overview\/help\/tickets\/[^/]+$/;

test('create: the ticket belongs to the marketer, the thread starts with the marketer\'s own text, and the confirmation opens the marketer ticket page', async t => {
  const fx = makeFixture();
  const svc = await load(t, fx);
  await svc.create('mkt', { subject: 'سؤال عن السحب', category: 'استفسار وسيط تسويقي', description: 'لم يصلني تحويل السحب الأخير بعد' });
  assert.equal(fx.created[0].userId, 'mkt');
  assert.equal(fx.messages.at(-1).senderId, 'mkt');
  assert.equal(fx.notifications.length, 1);
  assert.equal(fx.notifications[0].actionUrl, '/marketer-overview/help/tickets/t1');
  assert.match(fx.notifications[0].actionUrl, REAL_MARKETER_TICKET_ROUTE);
});

test('list: only the marketer\'s own tickets; another user sees none', async t => {
  const svc = await load(t, makeFixture());
  assert.equal((await svc.listForUser('mkt')).items.length, 1);
  assert.equal((await svc.listForUser('other')).items.length, 0);
});

test('unauthorized: another user reading / replying / closing the marketer\'s ticket gets 404, exactly like a missing one', async t => {
  const svc = await load(t, makeFixture());
  for (const call of [() => svc.getForUser('t1', 'other'), () => svc.reply('t1', 'other', 'x'), () => svc.close('t1', 'other'), () => svc.getForUser('nope', 'mkt')]) {
    await assert.rejects(call, (e: any) => e.statusCode === 404);
  }
});

test('marketer reply is stored; admin reply is visible in the marketer thread with sender info, moves the status and notifies with the marketer route', async t => {
  const fx = makeFixture('OPEN');
  const svc = await load(t, fx);
  await svc.reply('t1', 'mkt', 'هل من جديد؟');
  const r = await svc.replyAsStaff('t1', 'staff', 'نراجع طلبك الآن');
  assert.equal(r.status, 'AWAITING_CUSTOMER');
  const detail = await svc.getForUser('t1', 'mkt');
  const last = detail.messages.at(-1);
  assert.equal(last.body, 'نراجع طلبك الآن');
  assert.equal(last.sender.accountType, 'ADMIN');
  assert.equal(detail.ticket.status, 'AWAITING_CUSTOMER');
  const n = fx.notifications.at(-1);
  assert.equal(n.userId, 'mkt');
  assert.equal(n.metadata.event, 'replied');
  assert.match(n.actionUrl, REAL_MARKETER_TICKET_ROUTE);
});

test('status change is stored and notifies the marketer with the Arabic label and the marketer route; a closed ticket takes no reply', async t => {
  const fx = makeFixture('OPEN');
  const svc = await load(t, fx);
  await svc.setStatus('t1', 'RESOLVED');
  assert.match(fx.notifications.at(-1).message, /محلولة/);
  assert.match(fx.notifications.at(-1).actionUrl, REAL_MARKETER_TICKET_ROUTE);
  await svc.close('t1', 'mkt');
  await assert.rejects(() => svc.reply('t1', 'mkt', 'x'), (e: any) => e.statusCode === 400);
});

test('static: no live-support promise on the ticket routes or in the service', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['./support-ticket.service.ts', '../routes/marketer-overview.routes.ts']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /خلال \d+ ساعة|دعم مباشر|live support/i);
  }
});
