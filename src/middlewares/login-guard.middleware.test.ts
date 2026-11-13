import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginGuardGate } from './login-guard.middleware';

const mk = (verdict: any) => { const log: string[] = []; const guard: any = { check: async () => verdict, recordFailure: async (k: any) => { log.push('fail:' + k.ip + ':' + k.email); }, recordSuccess: async (k: any) => { log.push('ok:' + k.email); } }; return { guard, log }; };
const run = async (gate: any, status: number, ip = '203.0.113.5', body: any = { email: ' A@B.com ' }) => {
	const handlers: Array<() => void> = []; const headers: Record<string, string> = {};
	const res: any = { statusCode: status, setHeader: (k: string, v: string) => { headers[k] = v; }, once: (_e: string, h: () => void) => handlers.push(h) };
	let err: any; await gate({ ip, body } as any, res, (e?: any) => { err = e; }); handlers.forEach(h => h()); await new Promise(r => setTimeout(r, 5)); return { err, headers };
};

test('a blocked address(+account) gets 429 + Retry-After and the password check is never reached; nothing is recorded for the rejected request', async () => {
	const { guard, log } = mk({ blocked: true, scope: 'PAIR', retryAfterSeconds: 90 });
	const gate = loginGuardGate(r => r.body.email, guard); const r = await run(gate, 200);
	assert.equal(r.err.statusCode, 429); assert.equal(r.headers['Retry-After'], '90'); assert.equal(r.err.errors?.[0]?.code ?? r.err.details?.[0]?.code, 'LOGIN_TEMPORARILY_BLOCKED'); assert.deepEqual(log, []);
});

test('only a 401 is a failure; success clears the pair counter; validation 400, 429 and 5xx are ignored; the e-mail is normalised', async () => {
	for (const [status, expect] of [[401, ['fail:203.0.113.5:a@b.com']], [200, ['ok:a@b.com']], [400, []], [429, []], [500, []]] as Array<[number, string[]]>) {
		const { guard, log } = mk({ blocked: false }); const gate = loginGuardGate(r => r.body.email, guard); const r = await run(gate, status); assert.equal(r.err, undefined); assert.deepEqual(log, expect, String(status));
	}
});

test('the address comes from req.ip (trust-proxy), never from a header the caller controls', async () => {
	const { guard, log } = mk({ blocked: false }); const gate = loginGuardGate(r => r.body.email, guard);
	const handlers: Array<() => void> = []; const res: any = { statusCode: 401, setHeader: () => undefined, once: (_e: string, h: () => void) => handlers.push(h) };
	await gate({ ip: '198.51.100.1', headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7' }, body: { email: 'x@y.z' } } as any, res, () => undefined); handlers.forEach(h => h()); await new Promise(r => setTimeout(r, 5));
	assert.deepEqual(log, ['fail:198.51.100.1:x@y.z']);
});
