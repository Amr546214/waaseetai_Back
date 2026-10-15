import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalErrorHandler } from '../middlewares/error.middleware';
import { AppError, fieldError, fieldErrors, zodAppError } from './app-error';
import { rejectWithdrawal, approveWithdrawal } from '../controllers/withdrawal.controller';
import { assignAdminDispute as assignDispute, addAdminDisputeNote as addDisputeNote, setAdminDisputeStatus as setDisputeStatus, resolveDisputeFinancial, resolveDispute } from '../controllers/dispute.controller';
import { adminReplyToTicket, adminAssignTicket, adminAddTicketNote } from '../controllers/support-ticket.controller';
import { AdminUsersController as UsersController } from '../controllers/admin-users.controller';
import { adminRejectOnboarding, adminRejectProviderKyc } from '../controllers/onboarding.controller';
import { AdminSpecialtiesController } from '../controllers/admin-specialties.controller';
import { changePassword } from '../controllers/provider-profile.controller';
import { platformSettingsService } from '../services/platform-settings.service';
import { adminBrokersService } from '../services/admin-brokers.service';
import { marketerKycService } from '../services/marketer-kyc.service';
import { adminCouponsService } from '../services/admin-coupons.service';
import { AdminUsersService } from '../services/admin-users.service';

const usersService = new AdminUsersService();
import { resolveDisputeFinancialSchema } from '../dtos/dispute.dto';

// Admin forms put a server message under the control named by errors[].field: every endpoint below answers the SAME status/message as before
// plus errors:[{field,message}] with the FE control names.
const ARABIC = /[؀-ۿ]/;
const wire = (err: any) => {
	const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
	globalErrorHandler(err, { method: 'POST', url: '/x' } as any, res, () => {});
	return res;
};
async function failOf(fn: () => unknown): Promise<any> { try { await fn(); } catch (e) { return e; } assert.fail('expected a failure'); }
async function viaNext(handler: (req: any, res: any, next: any) => unknown, body: any = {}): Promise<any> {
	let got: any; await handler({ body, params: { id: 'x', userId: 'x' }, query: {}, user: { id: 'a1', userId: 'a1', accountType: 'SUPER_ADMIN' } }, { json() {}, status() { return this; } }, (e: any) => { got = e; });
	return got;
}
function expectField(res: { statusCode: number; body: any }, status: number, field: string) {
	assert.equal(res.statusCode, status);
	assert.equal(res.body.success, false);
	assert.match(res.body.message, ARABIC);
	const hit = (res.body.errors ?? []).find((e: any) => e.field === field);
	assert.ok(hit, `errors must name "${field}": ${JSON.stringify(res.body)}`);
	assert.equal(typeof hit.message, 'string');
	assert.match(hit.message, ARABIC);
}

test('helpers: fieldError / fieldErrors / zodAppError produce the validate-dto shape and keep the status and message', () => {
	const e = fieldError('reason', 'سبب مطلوب');
	assert.equal(e.statusCode, 400); assert.equal(e.message, 'سبب مطلوب');
	assert.deepEqual(e.errors, [{ field: 'reason', path: 'reason', message: 'سبب مطلوب' }]);
	assert.equal(fieldError('x', 'm', 422).statusCode, 422);
	assert.equal(fieldErrors('s', [{ field: 'a', message: 'ma' }, { field: 'b', message: 'mb' }]).errors!.length, 2);
	const z = zodAppError([{ path: ['a', 'b'], message: 'bad', code: 'custom' }], 'ملخص', { 'a.b': 'نص عربي' });
	assert.equal(z.message, 'ملخص'); assert.equal((z.errors![0] as any).field, 'a.b'); assert.equal((z.errors![0] as any).message, 'نص عربي');
	// a custom Arabic zod message is kept; the override only replaces English defaults
	assert.equal((zodAppError([{ path: ['a'], message: 'مخصص' }], 's', { a: 'آخر' }).errors![0] as any).message, 'مخصص');
	const w = wire(fieldError('reason', 'سبب مطلوب'));
	assert.deepEqual(w.body, { success: false, message: 'سبب مطلوب', errors: [{ field: 'reason', path: 'reason', message: 'سبب مطلوب' }] });
});

test('401/403/404/409 AppErrors are NOT turned into field errors', () => {
	for (const s of [401, 403, 404, 409]) assert.equal(wire(new AppError('x', s)).body.errors, undefined);
});

test('withdrawals: reject without reason -> rejectionReason; approve with a too long note -> adminNote', async () => {
	const r = await viaNext(rejectWithdrawal, {});
	expectField(wire(r), 400, 'rejectionReason'); assert.equal(r.message, 'سبب رفض السحب مطلوب');
	const a = await viaNext(approveWithdrawal, { adminNote: 'x'.repeat(2001) });
	expectField(wire(a), 400, 'adminNote');
});

test('disputes: text decision, financial decision (amount boxes), assign, note, status', async () => {
	expectField(wire(await viaNext(resolveDispute, { action: 'resolve', resolution: '' })), 400, 'resolution');
	expectField(wire(await viaNext(assignDispute, {})), 400, 'assigneeId');
	expectField(wire(await viaNext(addDisputeNote, { body: '   ' })), 400, 'body');
	expectField(wire(await viaNext(setDisputeStatus, { status: 'NOPE' })), 400, 'status');
	const fin = await viaNext(resolveDisputeFinancial, { outcome: 'REFUND_CLIENT', refundToClient: 0, releaseToProvider: 5, expectedHeldAmount: 5, confirm: true });
	const w = wire(fin);
	assert.equal(w.statusCode, 400);
	assert.ok(w.body.errors.some((e: any) => e.field === 'refundToClient'), JSON.stringify(w.body));
	const bad = await viaNext(resolveDisputeFinancial, { outcome: 'SPLIT', refundToClient: 'x', releaseToProvider: 1, expectedHeldAmount: 1, confirm: true });
	expectField(wire(bad), 400, 'refundToClient');
});

test('financial dto: the "wrong box" issue carries the amount field (never an empty path)', () => {
	const issuesOf = (v: any) => (resolveDisputeFinancialSchema.safeParse(v) as any).error.issues;
	const base = { expectedHeldAmount: 10, confirm: true };
	assert.deepEqual(issuesOf({ ...base, outcome: 'REFUND_CLIENT', refundToClient: 10, releaseToProvider: 2 }).map((i: any) => i.path), [['releaseToProvider']]);
	assert.deepEqual(issuesOf({ ...base, outcome: 'RELEASE_PROVIDER', refundToClient: 3, releaseToProvider: 7 }).map((i: any) => i.path), [['refundToClient']]);
	assert.deepEqual(issuesOf({ ...base, outcome: 'SPLIT', refundToClient: 10, releaseToProvider: 0 }).map((i: any) => i.path), [['releaseToProvider']]);
});

test('support tickets: reply, assign, note', async () => {
	expectField(wire(await viaNext(adminReplyToTicket, { body: '' })), 400, 'body');
	expectField(wire(await viaNext(adminAssignTicket, {})), 400, 'assigneeId');
	expectField(wire(await viaNext(adminAddTicketNote, { body: '' })), 400, 'body');
});

test('users: status (missing status / short reason / bad status), roles, notify message', async () => {
	expectField(wire(await viaNext(UsersController.updateUserStatus as any, {})), 400, 'status');
	const actor: any = { id: 'a1', accountType: 'SUPER_ADMIN' };
	expectField(wire(await failOf(() => usersService.updateUserStatus(actor, 'u1', 'SUSPENDED', ' '))), 400, 'reason');
	expectField(wire(await failOf(() => usersService.updateUserStatus(actor, 'u1', 'BOGUS', 'سبب كافٍ'))), 400, 'status');
	expectField(wire(await failOf(() => usersService.updateUserRoles(actor, 'u1', { roles: [] }))), 400, 'roles');
	expectField(wire(await failOf(() => usersService.updateUserRoles(actor, 'u1', { roles: ['ADMIN'] }))), 400, 'roles');
	expectField(wire(await failOf(() => usersService.notifyUser(actor, 'u1', { message: 'abc' }))), 400, 'message');
	expectField(wire(await viaNext(UsersController.updateUserRoles as any, { roles: [] })), 400, 'roles');
	expectField(wire(await viaNext(UsersController.notifyUser as any, {})), 400, 'message');
	// 403 self-change stays a plain error
	assert.equal(wire(await failOf(() => usersService.updateUserStatus(actor, 'a1', 'ACTIVE'))).body.errors, undefined);
});

test('KYC rejects (provider/client onboarding + marketer + broker status + coupon) name the reason field', async () => {
	expectField(wire(await viaNext(adminRejectOnboarding, {})), 400, 'rejectionReason');
	expectField(wire(await viaNext(adminRejectProviderKyc, { rejectionReason: 'x' })), 400, 'rejectionReason');
	expectField(wire(await failOf(() => marketerKycService.reject('a', 'b', ' '))), 400, 'reason');
	expectField(wire(await failOf(() => adminBrokersService.setBrokerStatus('a', 'b', { status: 'SUSPENDED', reason: 'x' }))), 400, 'reason');
	expectField(wire(await failOf(() => adminCouponsService.setActive('a', 'b', { active: false, reason: '' }))), 400, 'reason');
});

test('specialties/categories: missing slug / nameAr and bad types name their fields', async () => {
	const miss = wire(await viaNext(AdminSpecialtiesController.createCategory as any, {}));
	expectField(miss, 400, 'slug'); expectField(miss, 400, 'nameAr');
	expectField(wire(await viaNext(AdminSpecialtiesController.createCategory as any, { slug: 'a', nameAr: 'ب', sortOrder: 1.5 })), 400, 'sortOrder');
});

test('system settings: each invalid value is reported under its setting key', () => {
	const e: any = (() => { try { platformSettingsService.validate({ supportEmail: 'not-an-email', nope: 'x' }); } catch (x) { return x; } })();
	assert.equal(e.statusCode, 400);
	const fields = e.errors.map((x: any) => x.field);
	assert.ok(fields.includes('supportEmail') && fields.includes('nope'), JSON.stringify(e.errors));
});

test('my account password: the code stays the message, errors names the box', async () => {
	const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
	await (changePassword as any)({ body: {}, user: { id: 'u1' }, headers: {}, ip: '1.1.1.1', get: () => '' }, res);
	assert.equal(res.statusCode, 400); assert.equal(res.body.message, 'PASSWORD_FIELDS_REQUIRED');
	assert.deepEqual(res.body.errors.map((e: any) => e.field).sort(), ['currentPassword', 'newPassword']);
});
