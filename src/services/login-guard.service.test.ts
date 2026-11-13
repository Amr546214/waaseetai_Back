import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, maskEmail } from './login-guard.service';

const load = async (t: TestContext, cfg = { loginMaxFailedAttempts: 3, loginAttemptWindowMinutes: 15, loginBlockMinutes: 10, loginIpMaxFailedAttempts: 5 }) => {
	t.mock.module('./system-settings.service', { namedExports: { systemSettingsService: { get: async (k: string) => (cfg as any)[k] } } });
	t.mock.module('../config/logger', { namedExports: { logger: { warn: () => undefined, error: () => undefined, info: () => undefined } } });
	const mod = await import(`./login-guard.service?m=${Math.random()}`);
	return mod;
};

test('IPv4-mapped IPv6 is normalised and e-mails are masked (the admin list never shows a full address)', () => {
	assert.equal(normalizeIp('::FFFF:203.0.113.9'), '203.0.113.9'); assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1'); assert.equal(maskEmail('Sara@Example.com'), 'S***@Example.com');
});

test('config is read from the settings service per call (a new value applies without a restart)', async (t: TestContext) => {
	const { LoginGuardService } = await load(t); const g = new LoginGuardService({} as any);
	assert.deepEqual(await g.config(), { maxFails: 3, windowMin: 15, blockMin: 10, ipMaxFails: 5 });
});

test('a failed attempt bumps BOTH the address+account counter and the address-wide counter, with the thresholds from the settings', async (t: TestContext) => {
	const { LoginGuardService } = await load(t); const calls: any[] = [];
	const g = new LoginGuardService({ $executeRawUnsafe: async (...a: any[]) => { calls.push(a); return 1; } } as any);
	await g.recordFailure({ ip: '::ffff:198.51.100.7', email: 'A@B.com' });
	assert.equal(calls.length, 2);
	const [ipCall, pairCall] = calls; assert.match(ipCall[1], /^i:198\.51\.100\.7$/); assert.equal(ipCall[2], 'IP'); assert.equal(ipCall[5], 5);
	assert.match(pairCall[1], /^p:198\.51\.100\.7\|[0-9a-f]{32}$/); assert.equal(pairCall[2], 'PAIR'); assert.equal(pairCall[5], 3); assert.equal(pairCall[4], 'a***@b.com');
	assert.equal(pairCall[6], 10, 'block minutes'); assert.equal(pairCall[7], 15, 'window minutes');
	assert.ok(!calls.flat().some(x => typeof x === 'string' && x.includes('A@B.com')), 'the full e-mail is never stored');
});

test('without an e-mail only the address counter moves; a success clears only the pair counter; storage errors fail OPEN', async (t: TestContext) => {
	const { LoginGuardService } = await load(t); const sql: string[] = [];
	const g = new LoginGuardService({ $executeRawUnsafe: async (q: string, ...a: any[]) => { sql.push(q + '|' + a[0]); return 1; }, $queryRawUnsafe: async () => { throw new Error('boom'); } } as any);
	await g.recordFailure({ ip: '1.2.3.4' }); assert.equal(sql.length, 1); assert.match(sql[0], /\|i:1\.2\.3\.4$/);
	sql.length = 0; await g.recordSuccess({ ip: '1.2.3.4', email: 'a@b.com' }); assert.equal(sql.length, 1); assert.match(sql[0], /DELETE/); assert.match(sql[0], /blocked_until/); assert.match(sql[0].split('|')[1], /^p:/);
	assert.deepEqual(await g.check({ ip: '1.2.3.4', email: 'a@b.com' }), { blocked: false });
});

test('check reports the longest active block with its remaining wait; impact is computed against the candidate limits', async (t: TestContext) => {
	const { LoginGuardService } = await load(t);
	const g = new LoginGuardService({ $queryRawUnsafe: async (q: string) => (/CEIL/.test(q) ? [{ scope: 'IP', secs: 125 }] : [{ scope: 'PAIR', blocked: 2, would: 3, total: 9 }, { scope: 'IP', blocked: 1, would: 0, total: 4 }]) } as any);
	assert.deepEqual(await g.check({ ip: '1.1.1.1' }), { blocked: true, scope: 'IP', retryAfterSeconds: 125 });
	const i = await g.impact({ maxFails: 4 }); assert.equal(i.candidate.maxFails, 4); assert.equal(i.current.maxFails, 3); assert.deepEqual(i.activeBlocks, { pair: 2, ip: 1 }); assert.deepEqual(i.wouldBlockNextFailure, { pair: 3, ip: 0 });
});
