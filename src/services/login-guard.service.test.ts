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

test('invalid policy cannot put the IP limit below the pair limit; missing schema explicitly retains legacy protection', async (t: TestContext) => {
 const {LoginGuardService,validateLoginPolicy}=await load(t);
 assert.throws(()=>validateLoginPolicy({maxFails:20,ipMaxFails:5,windowMin:10,blockMin:10}));
 const g=new LoginGuardService({$transaction:async()=>{throw Error('missing table');}} as any);
 assert.deepEqual(await g.reserve({ip:'1.2.3.4'}),{blocked:false,storage:false});
});

test('check reports the longest active block with its remaining wait; impact is computed against the candidate limits', async (t: TestContext) => {
	const { LoginGuardService } = await load(t);
	const g = new LoginGuardService({ $queryRawUnsafe: async (q: string) => (/CEIL/.test(q) ? [{ scope: 'IP', seconds: 125 }] : [{ scope: 'PAIR', blocked: 2, would: 3, total: 9 }, { scope: 'IP', blocked: 1, would: 0, total: 4 }]) } as any);
	assert.deepEqual(await g.check({ ip: '1.1.1.1' }), { blocked: true, scope: 'IP', retryAfterSeconds: 125 });
	const i = await g.impact({ maxFails: 4,windowMin:undefined }); assert.equal(i.candidate.maxFails, 4);assert.equal(i.candidate.windowMin,15); assert.equal(i.current.maxFails, 3); assert.deepEqual(i.activeBlocks, { pair: 2, ip: 1, account:0 }); assert.deepEqual(i.wouldBlockNextFailure, { pair: 3, ip: 0 });
});
