import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// PayPal is the only payout destination: an OLD withdrawal row that still carries a bank destination never leaks it, not even to the admin
// (list / get / approve / reject answers), and the API docs carry no bank example.

const OLD_ROW = { id: 'w1', userId: 'u1', amount: 50, currency: 'USD', method: 'bank_transfer', status: 'COMPLETED', iban: 'SA0380000000608010167519', accountName: 'Old Holder', accountNumber: '123456789', paypalEmail: null };

async function load(t: TestContext) {
  const findUnique = t.mock.fn(async (args: any) => ({ ...OLD_ROW, user: { id: 'u1', firstName: 'A', lastName: 'B', email: 'a@b.co', accountType: 'PROVIDER_INDIVIDUAL', walletBalance: 0 }, reviewedBy: null }));
  const select = { user: { findUnique: async () => ({ accountType: 'PROVIDER_INDIVIDUAL', roles: ['PROVIDER'], activeRole: 'PROVIDER', affiliateProfile: null }) } };
  t.mock.module('../config/db', { namedExports: { prisma: {
    withdrawal: { findMany: async () => [{ ...OLD_ROW, user: {}, reviewedBy: null }], count: async () => 1, findUnique, aggregate: async () => ({ _sum: { amount: 0 } }) },
    ...select,
  } } });
  t.mock.module('./provider-finance.service', { namedExports: { providerFinanceService: { getWallet: async () => ({ summary: { availableBalance: 0, currency: 'USD' } }) } } });
  const mod = await import(`./withdrawal.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return mod;
}

test('admin list: an old bank row is returned without iban / accountName / accountNumber', async (t) => {
  const { withdrawalService } = await load(t);
  const out = await withdrawalService.list();
  const row: any = out.items[0];
  for (const k of ['iban', 'accountName', 'accountNumber']) assert.equal(k in row, false, k);
  assert.equal(row.method, 'bank_transfer'); // history is kept, only the bank destination is hidden
  assert.doesNotMatch(JSON.stringify(out), /SA0380000000608010167519|Old Holder|123456789/);
});

test('admin detail: no bank destination on the row and no iban / bankName on the nested user select', async (t) => {
  const { withdrawalService } = await load(t);
  const out: any = await withdrawalService.get('w1');
  for (const k of ['iban', 'accountName', 'accountNumber']) assert.equal(k in out, false, k);
  assert.doesNotMatch(JSON.stringify(out), /SA0380000000608010167519|Old Holder|123456789/);
  const src = fs.readFileSync(path.join(import.meta.dirname, 'withdrawal.service.ts'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('async get(id: string)'), src.indexOf('async get(id: string)') + 600), /ibanNumber|bankName/);
});

test('API docs (swagger) carry no bank / IBAN / wallet example or schema', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../config/swagger.ts'), 'utf8');
  assert.doesNotMatch(src, /BankingInfoRequest|ibanNumber|bankName|accountHolderName|walletProvider|walletPhone|paymentMethod: 'bank'/);
});
