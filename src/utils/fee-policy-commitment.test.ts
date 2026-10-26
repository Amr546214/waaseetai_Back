import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WHERE a fee policy is chosen. The rule: a policy is read only at the moment an operation is CREATED (the escrow is locked, a deposit is quoted, a withdrawal is requested) and is stored on that row;
 * everything that happens to the operation later (release, partial release, dispute split, amendment, refund, capture retry, approval) uses what the row stores. Adding a new reader needs a decision here.
 */
const root = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const walk = (d: string, out: string[] = []): string[] => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.ts') && !/\.(test|spec)\.ts$|pgenv/.test(f.name)) out.push(p); } return out; };

test('policy readers: only creation points, display, the marketer ladder of the escrow\'s own version and the admin API read a policy', () => {
	const users = walk(root).filter(f => /feePolicyService\.(active|byId|upcoming)\(/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(root, f)).sort();
	assert.deepEqual(users, [
		'controllers/gamification.controller.ts',          // display of the table in force
		'services/affiliate-commission.service.ts',         // byId(escrow.feePolicyId): the ladder of the version the escrow was locked under
		'services/cart-checkout.service.ts',                // escrow creation
		'services/client-requests.service.ts',              // escrow creation (sign + fund are ONE transaction)
		'services/marketer-wallet.service.ts',              // display of the current floor
		'services/paypal-finance.service.ts',               // deposit quote (creation)
		'services/withdrawal.service.ts',                   // withdrawal request (creation)
	].sort());
});

test('later events use the escrow\'s stored terms: release, dispute split and amendments never ask the policy', () => {
	for (const f of ['services/project-progress.service.ts', 'services/dispute.service.ts', 'services/amendment-apply.service.ts']) {
		const src = read(f); assert.ok(!/feePolicyService/.test(src), f); assert.ok(/providerCommissionRateSnapshot/.test(src), `${f} uses the frozen rate`);
	}
});

test('a PayPal capture (or a retried capture / webhook) uses the quote stored on the payment, never the current policy', () => {
	const src = read('services/paypal-finance.service.ts'); const create = src.indexOf('initiateDeposit'); assert.ok(create >= 0);
	assert.equal((src.match(/feePolicyService\.active\(/g) || []).length, 1, 'only the quote reads the policy');
	assert.ok(/payment\.feePercent/.test(src) && /payment\.feeAmount/.test(src), 'capture reads the stored fee');
});

test('withdrawal approval / rejection / payout never re-check the minimum or the policy; only the request does', () => {
	const src = read('services/withdrawal.service.ts');
	assert.equal((src.match(/feePolicyService\.active\(/g) || []).length, 2, 'provider request + marketer request only');
	assert.ok(/minimumApplied/.test(src) && /feePolicyId: /.test(src), 'the request stores what it applied');
});

test('sign + fund is ONE transaction: the escrow (with its policy snapshot) is created in the same transaction that debits the wallet and marks the contract signed', () => {
	const src = read('services/client-requests.service.ts'); const i = src.indexOf('buildEscrowSnapshotFromPolicy(providerGamification'); assert.ok(i > 0);
	const before = src.slice(0, i); const txStart = before.lastIndexOf('prisma.$transaction'); assert.ok(txStart > before.lastIndexOf('public async depositEscrow'), 'the read happens inside the deposit transaction');
	const after = src.slice(i, i + 2500); assert.ok(/debitWalletIfCovered\(tx, userId/.test(after) && /escrow\.upsert/.test(src.slice(i, i + 6000)), 'wallet debit and escrow creation follow in that transaction');
});
