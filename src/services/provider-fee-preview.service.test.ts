import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const POLICY = { id: 'pol', version: 5, effectiveFrom: new Date('2026-10-01'), payload: { providerCommissionByLevel: Array.from({ length: 15 }, (_, i) => 12.75 - i * 0.3) } };
let level: number | null = 1;
mock.module('../config/db', { namedExports: { prisma: { providerGamification: { findUnique: async () => (level == null ? null : { currentLevelIndex: level }) } } } });
mock.module('./fee-policy.service', { namedExports: { feePolicyService: { active: async () => POLICY } } });
const load = async (l: number | null) => { level = l; return (await import('./provider-fee-preview.service')).providerFeePreviewService; };

test('fee preview: the commission and net come from the provider\'s level and the active policy, and say they are an estimate that is frozen at funding', async () => {
	const s = await load(1); const p = await s.preview('prov', '1000', undefined);
	assert.deepEqual({ level: p.level, ratePercent: p.ratePercent, commission: p.commission, net: p.net, currency: p.currency }, { level: 1, ratePercent: 12.75, commission: 127.5, net: 872.5, currency: 'USD' });
	assert.equal(p.isEstimate, true); assert.equal(p.lockedAt, 'ESCROW_FUNDING'); assert.match(p.note, /يوقّع العميل ويموّل الضمان/); assert.equal(p.policy.version, 5);
});
test('fee preview: a provider without a level row is level 1; a higher level pays less; the currency is the one asked for (SAR allowed in the infrastructure)', async () => {
	assert.equal((await (await load(null)).preview('p', 100, 'SAR')).level, 1);
	const hi = await (await load(15)).preview('p', 1000, 'SAR'); assert.ok(hi.commission < 127.5); assert.equal(hi.currency, 'SAR');
});
test('fee preview: nonsense is refused, never computed (negative, zero, NaN, huge, unknown currency)', async () => {
	const s = await load(1);
	for (const bad of [-5, 0, 'abc', NaN, Infinity, 1e12, null, undefined]) await assert.rejects(s.preview('p', bad, 'USD'), (e: any) => e.statusCode === 400, String(bad));
	await assert.rejects(s.preview('p', 100, 'EUR'), (e: any) => e.code === 'CURRENCY_UNSUPPORTED');
});
test('the preview route is behind authenticate + requireActiveUser + providerOnly', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'provider.routes.ts'), 'utf8');
	assert.match(src, /router\.get\('\/finance\/fee-preview', authenticate, requireActiveUser, providerOnly, getProviderFeePreview\)/);
});
