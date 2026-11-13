import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

test('publishing tells THIS process directly, carries keys only, and notifies the database channel', async (t: TestContext) => {
	const queries: any[] = [];
	t.mock.module('../config/db', { namedExports: { prisma: { $executeRaw: async (...a: any[]) => { queries.push(a); return []; } } } });
	t.mock.module('../config/logger', { namedExports: { logger: { warn: () => undefined, error: () => undefined, info: () => undefined } } });
	const bus = await import(`./settings-bus?m=${Math.random()}`);
	const seen: any[] = []; bus.onSettingsNotice((n: any) => { seen.push(n); });
	await bus.publishSettingsChange(['maintenanceMode', 'maintenanceBannerText']); await new Promise(r => setTimeout(r, 10));
	assert.equal(seen.length, 1); assert.deepEqual(seen[0].keys, ['maintenanceMode', 'maintenanceBannerText']); assert.equal(seen[0].origin, bus.INSTANCE_ID);
	assert.equal(queries.length, 1); const payload = JSON.parse(queries[0][2]); assert.deepEqual(Object.keys(payload).sort(), ['at', 'keys', 'origin']);
	assert.equal(queries[0][1], bus.SETTINGS_CHANNEL);
});

test('a failing notify never throws (other instances converge by cache TTL) and a failing handler does not stop the others', async (t: TestContext) => {
	t.mock.module('../config/db', { namedExports: { prisma: { $executeRaw: async () => { throw new Error('db down'); } } } });
	t.mock.module('../config/logger', { namedExports: { logger: { warn: () => undefined, error: () => undefined, info: () => undefined } } });
	const bus = await import(`./settings-bus?m=${Math.random()}`);
	let ok = 0; bus.onSettingsNotice(() => { throw new Error('boom'); }); bus.onSettingsNotice(() => { ok++; });
	await bus.publishSettingsChange(['x']); await new Promise(r => setTimeout(r, 10)); assert.equal(ok, 1);
});
