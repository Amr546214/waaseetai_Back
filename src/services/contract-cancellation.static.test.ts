import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// «الإلغاء بالتراضي» money-OFF guard: until the settlement rule is approved, this service must not be able to move money or close anything.
const src = fs.readFileSync(path.join(__dirname, 'contract-cancellation.service.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the cancellation service never writes escrow, wallet, wallet transaction, stage, user, project or dispute rows', () => {
	for (const model of ['escrow', 'walletTransaction', 'projectStage', 'user', 'project', 'dispute', 'withdrawal', 'stageDelivery']) {
		assert.doesNotMatch(src, new RegExp(`prisma\\.${model}\\.(create|update|updateMany|upsert|delete|deleteMany)\\b|tx\\.${model}\\.(create|update|updateMany|upsert|delete|deleteMany)\\b`), `${model} must not be written`);
	}
});
test('the only contract write is the harmless updatedAt lock that serialises concurrent requests (status is never changed)', () => {
	const calls = src.split(/tx\.contract\.(\w+)\(/).slice(1);
	assert.equal(calls.length / 2, 1, 'exactly one tx.contract call');
	assert.equal(calls[0], 'updateMany'); assert.match(calls[1].split(');')[0], /data: \{ updatedAt: new Date\(\) \}/);
	assert.doesNotMatch(src, /prisma\.contract\.(update|updateMany|delete)/);
});
test('an accepted request only reaches PENDING_ADMIN_DECISION; no settled state exists', async () => {
	const { CancellationSettlementStatus } = await import('@prisma/client');
	assert.deepEqual(Object.values(CancellationSettlementStatus).sort(), ['NOT_APPLICABLE', 'PENDING_ADMIN_DECISION']);
});
