import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireOfficialDeployment, OPERATIONS_PANEL_UNAVAILABLE } from './official-deployment.middleware';

const call = () => { let err: any; requireOfficialDeployment({} as any, {} as any, (e?: any) => { err = e; }); return err; };
test('dev (no official flag) refuses the operations panel with the stable code, whatever the Host header or NODE_ENV says; the official config passes', () => {
	const saved = { ...process.env };
	try {
		process.env.NODE_ENV = 'production'; process.env.FRONTEND_URL = 'https://dev.waseetai.com'; delete process.env.PLATFORM_DEPLOY_ENV;
		const e = call(); assert.equal(e.statusCode, 403); assert.equal(e.code ?? e.errorCode, OPERATIONS_PANEL_UNAVAILABLE);
		process.env.PLATFORM_DEPLOY_ENV = 'official'; assert.ok(call(), 'flag set but FRONTEND_URL is dev: still refused');
		process.env.FRONTEND_URL = 'https://waseetai.com'; assert.equal(call(), undefined);
	} finally { process.env = saved; }
});
