import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// «الإلغاء بالتراضي»: money moves ONLY inside settle() (admin, financial permission pair); the request lifecycle (create / respond / withdraw) never writes money.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const src = strip(fs.readFileSync(path.join(__dirname, 'contract-cancellation.service.ts'), 'utf8'));
const a = src.indexOf('async settle('), b = src.indexOf('private async afterSettle');
const outside = src.slice(0, a) + src.slice(b);
const inside = src.slice(a, b);

test('outside settle() the service never writes escrow, wallet, wallet transaction, stage, user, project, dispute or the contract status', () => {
	assert.ok(a > 0 && b > a);
	for (const model of ['escrow', 'walletTransaction', 'projectStage', 'user', 'project', 'dispute', 'withdrawal', 'stageDelivery', 'clientRequest', 'accountAuditLog']) {
		assert.doesNotMatch(outside, new RegExp(`(prisma|tx)\\.${model}\\.(create|update|updateMany|upsert|delete|deleteMany)\\b`), `${model} must not be written outside settle()`);
	}
	const writes = [...outside.matchAll(/tx\.contract\.(create|update|updateMany|upsert|delete|deleteMany)\(([\s\S]*?)\);/g)];
	assert.equal(writes.length, 1, 'exactly one contract write outside settle()'); assert.equal(writes[0][1], 'updateMany'); assert.match(writes[0][2], /data: \{ updatedAt: new Date\(\) \}/);
	assert.doesNotMatch(outside, /prisma\.contract\.(update|updateMany|delete)/);
});
test('settle() checks the financial permission pair FIRST, takes the contract lock, refuses an open dispute and claims the request conditionally', () => {
	assert.match(inside.slice(0, 400), /assigneeHolds\(adminId, \['disputes\.resolve', 'payouts\.send'\]\)/);
	assert.match(inside, /lockProjectForFreezeCheck\(tx/); assert.match(inside, /assertProjectNotFrozen\(pre\.projectId, tx\)/);
	assert.match(inside, /updateMany\(\{ where: \{ id, status: CancellationRequestStatus\.AGREED_PENDING_SETTLEMENT \}/);
	assert.match(inside, /CANCEL-REFUND-\$\{id\}/);
});
test('the admin settle route needs BOTH financial permissions on the acting role; reading needs disputes.view', () => {
	const r = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-cancellation-requests.routes.ts'), 'utf8');
	assert.match(r, /requirePermission\('disputes\.view'\)/); assert.match(r, /post\('\/:id\/settle', requirePermission\('disputes\.resolve', 'payouts\.send'\), authorizeAdminActing/);
});
test('the stage approval and the amendment application are frozen by an agreed cancellation', () => {
	const prog = fs.readFileSync(path.join(__dirname, 'project-progress.service.ts'), 'utf8'); assert.match(prog, /assertNoAgreedCancellation\(\{ contractId: contract\.id/);
	const am = fs.readFileSync(path.join(__dirname, 'amendment-apply.service.ts'), 'utf8'); assert.match(am, /hasAgreedCancellation\(/);
});
test('settlement statuses', async () => {
	const { CancellationSettlementStatus, CancellationRequestStatus } = await import('@prisma/client');
	assert.deepEqual(Object.values(CancellationSettlementStatus).sort(), ['NOT_APPLICABLE', 'PENDING_ADMIN_DECISION', 'SETTLED']);
	assert.ok('AGREED_PENDING_SETTLEMENT' in CancellationRequestStatus && 'SETTLED' in CancellationRequestStatus);
});
