import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AddAccountTypeSchema } from '../dtos/account-management.dto';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { AccountManagementController } from '../controllers/account-management.controller';
import { accountManagementService } from './account-management.service';

// POST /user/add-account-type: structured errors instead of the English "Internal Server Error".

function mockRes() {
  const res: any = { statusCode: null, body: null, cookie: () => res };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

// A prisma whose ClientProfile table is missing a column: any read WITHOUT an explicit select fails,
// exactly like the prod 500 ("The column client_profiles.paypalPayoutEmail does not exist").
function mockPrismaMissingColumn(t: TestContext, roles: string[]) {
  const user: any = { id: 'user-1', accountType: 'CLIENT_INDIVIDUAL', roles, firstName: 'A', lastName: 'B', avatarUrl: null, email: 'a@b.co', phoneNumber: '1',
    idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null, accountHolderName: null, idDocumentUrl: null };
  const needSelect = (args: any) => { if (!args?.select) throw new Error('The column `client_profiles.paypalPayoutEmail` does not exist in the current database.'); return { id: 'c1' }; };
  const tx: any = {
    clientProfile: { findUnique: async (a: any) => needSelect(a), create: async (a: any) => needSelect(a) },
    providerProfile: { findUnique: async () => null, create: async () => ({ id: 'p1' }) },
    providerGamification: { findUnique: async () => null, create: async () => ({}) },
    affiliateProfile: { findUnique: async () => null, create: async () => ({ id: 'a1' }) },
    user: { update: async () => user },
    accountAuditLog: { create: async () => ({}) },
  };
  t.mock.module('../config/db', { namedExports: { prisma: { user: { findUnique: async () => user }, $transaction: async (fn: any) => fn(tx) } } });
}

test('already owning the role is a 409 conflict with an Arabic message (not a 500)', async (t) => {
  process.env.JWT_SECRET = 'x';
  mockPrismaMissingColumn(t, ['CLIENT', 'PROVIDER']);
  const { accountManagementService: svc } = await import(`./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`);
  await assert.rejects(() => svc.addAccountType('user-1', 'PROVIDER', {}), (e: any) => e.statusCode === 409 && /[؀-ۿ]/.test(e.message));
});

test('the existing-client-profile check no longer reads every column (a missing column does not 500 the request)', async (t) => {
  process.env.JWT_SECRET = 'x';
  mockPrismaMissingColumn(t, ['CLIENT']);
  const { accountManagementService: svc } = await import(`./account-management.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const r = await svc.addAccountType('user-1', 'PROVIDER', { specMain: 'تصميم' });
  assert.equal(r.user.activeRole, 'PROVIDER');
});

test('controller: a non-AppError (DB failure) becomes an Arabic 500 AppError, never the raw English message', async (t) => {
  t.mock.method(accountManagementService, 'addAccountType', async () => { throw new Error('The column `x` does not exist'); });
  let err: any;
  await new AccountManagementController().addAccountType({ user: { userId: 'u' }, body: { targetRole: 'PROVIDER' }, get: () => '' } as any, mockRes(), (e?: unknown) => { err = e; });
  assert.equal(err.statusCode, 500);
  assert.equal(err.message, 'تعذر إرسال طلب إضافة الحساب. حاول مرة أخرى أو تواصل مع الدعم.');
  assert.doesNotMatch(err.message, /column|Internal/i);
});

test('controller: an AppError (e.g. the 409 conflict) is passed through unchanged', async (t) => {
  const { AppError } = await import('../utils/app-error');
  const conflict = new AppError('أنت تمتلك هذا الحساب بالفعل', 409);
  t.mock.method(accountManagementService, 'addAccountType', async () => { throw conflict; });
  let err: any;
  await new AccountManagementController().addAccountType({ user: { userId: 'u' }, body: { targetRole: 'PROVIDER' }, get: () => '' } as any, mockRes(), (e?: unknown) => { err = e; });
  assert.equal(err, conflict);
});

async function runValidate(body: any) {
  const res = mockRes(); let called = false;
  await validateDto(AddAccountTypeSchema)({ body } as any, res, () => { called = true; });
  return { res, called };
}

test('validation: a bad role and bad metadata give a 400 with several errors, each with field/path/message/code', async () => {
  const { res, called } = await runValidate({ targetRole: 'ADMIN', profileMetadata: { portfolioBio: 'x'.repeat(1001), specMain: 5, skills: 'x' } });
  assert.equal(called, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.ok(res.body.errors.length >= 3);
  for (const e of res.body.errors) for (const k of ['field', 'path', 'message', 'code']) assert.ok(e[k] !== undefined, `${e.field}.${k}`);
  const fields = res.body.errors.map((e: any) => e.field);
  assert.ok(fields.includes('profileMetadata.portfolioBio') && fields.includes('targetRole'));
});

test('validation: a normal wizard payload (and unknown keys) still passes', async () => {
  const { res, called } = await runValidate({ targetRole: 'PROVIDER', profileMetadata: { specMain: 'تصميم', specExp: '3-5 سنوات', portfolioBio: 'نبذة', skills: ['Figma'], chType: '', other: 1 } });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});
