import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Payout P2-C: the same static-source-check approach already established
// for admin-affiliate-requests.routes.test.ts — this codebase's test suite
// does not boot a real Express app, so route-level authorization is proven
// by confirming the guard middleware chain is actually wired in, statically,
// rather than by an HTTP integration test. authorize()'s own decision logic
// (ADMIN/SUPER_ADMIN allowed; CLIENT/PROVIDER/AFFILIATE/unauthenticated
// blocked) is already unit-tested generically elsewhere
// (src/middlewares/auth.middleware.test.ts) — this only confirms THIS
// router applies that same guard to send-payout, exactly like approve/reject.

const source = fs.readFileSync(path.join(__dirname, 'admin-withdrawals.routes.ts'), 'utf8');

test('admin-withdrawals router is gated by authenticate + requireActiveUser + authorize(ADMIN, SUPER_ADMIN)', () => {
	assert.match(source, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)\)/);
});

test('the router.use(...) guard line appears BEFORE every route registration, including send-payout — no route is registered ahead of the guard', () => {
	const guardIndex = source.indexOf('router.use(authenticate');
	assert.notEqual(guardIndex, -1);

	for (const routeSnippet of [
		"router.get('/', listWithdrawals)",
		"router.get('/:id', getWithdrawal)",
		"router.post('/:id/approve', approveWithdrawal)",
		"router.post('/:id/reject', rejectWithdrawal)",
		"router.post('/:id/send-payout', sendWithdrawalPayout)"
	]) {
		const routeIndex = source.indexOf(routeSnippet);
		assert.notEqual(routeIndex, -1, `expected to find: ${routeSnippet}`);
		assert.ok(routeIndex > guardIndex, `${routeSnippet} must be registered AFTER the router.use(...) guard`);
	}
});

test('send-payout is a distinct route/action from approve — they are never combined into one handler', () => {
	assert.match(source, /router\.post\('\/:id\/approve',\s*approveWithdrawal\)/);
	assert.match(source, /router\.post\('\/:id\/send-payout',\s*sendWithdrawalPayout\)/);
	// Two different handler functions imported and wired to two different
	// paths — not the same function reused, and not send-payout folded into
	// approve's own path.
	assert.notEqual(source.match(/router\.post\('\/:id\/approve',\s*(\w+)\)/)?.[1], source.match(/router\.post\('\/:id\/send-payout',\s*(\w+)\)/)?.[1]);
});
