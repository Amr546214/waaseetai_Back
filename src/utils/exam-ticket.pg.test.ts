import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { issueExamTicket, consumeExamTicket } from './exam-ticket';
import { prisma } from '../config/db';
const url = process.env.QA_ISOLATED_PG_URL;
const enabled = !!url && url === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(url);
const opts = { skip: enabled ? false : 'isolated local PostgreSQL on :55432 only' };
after(async () => { if (enabled) await prisma.$disconnect(); });

test('PG ticket: competing backend processes consume once, and a fresh process cannot replay it', opts, async () => {
  const userId = randomUUID(), sessionId = randomUUID();
  const { ticket } = issueExamTicket(userId, sessionId, 'SETUP_TEST');
  const run = promisify(execFile);
  const source = `const {consumeExamTicket}=require('./src/utils/exam-ticket.ts');const {prisma}=require('./src/config/db.ts');(async()=>{try{const ok=await consumeExamTicket(process.env.REVIEW_TICKET,JSON.parse(process.env.REVIEW_EXPECT));console.log(JSON.stringify({ok}));}finally{await prisma.$disconnect()}})();`;
  const env = { ...process.env, REVIEW_TICKET: ticket, REVIEW_EXPECT: JSON.stringify({ userId, sessionId, scope: 'SETUP_TEST' }) };
  const consume = async () => {
    const r = await run(process.execPath, ['--import', 'tsx', '-e', source], { env });
    return JSON.parse(r.stdout.trim().split('\n').at(-1)!).ok as boolean;
  };
  const results = await Promise.all([consume(), consume()]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await consume(), false, 'a new process still sees the consumed jti');
  const rows = await prisma.$queryRaw<{ scope: string }[]>`SELECT scope FROM exam_ticket_uses WHERE "userId" = ${userId}`;
  assert.deepEqual(rows, [{ scope: 'SETUP_TEST' }]);
});

test('PG ticket: a failed or expired ticket persists no use; database errors fail closed', opts, async () => {
  const who = { userId: randomUUID(), sessionId: randomUUID(), scope: 'SETUP_TEST' as const };
  const { ticket } = issueExamTicket(who.userId, who.sessionId, who.scope);
  assert.equal(await consumeExamTicket(ticket, { ...who, sessionId: 'wrong' }), false);
  const unavailable = { claim: async () => { throw new Error('store unavailable'); } };
  assert.equal(await consumeExamTicket(ticket, who, process.env, unavailable), false);
  assert.equal(await consumeExamTicket(ticket, who), true, 'invalid proof or failed storage never spends the ticket');
});
