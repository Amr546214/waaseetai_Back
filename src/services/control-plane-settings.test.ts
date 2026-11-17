import assert from 'node:assert/strict';
import test from 'node:test';
import { controlPlaneUrl, controlTarget } from '../config/control-plane-db';

test('control plane is off unless CONTROL_PLANE_DATABASE_URL is set', () => {
	assert.equal(controlPlaneUrl({} as NodeJS.ProcessEnv), '');
	assert.equal(controlTarget({} as NodeJS.ProcessEnv), 'LOCAL');
	assert.equal(controlTarget({ CONTROL_PLANE_DATABASE_URL: '   ' } as NodeJS.ProcessEnv), 'LOCAL');
});

test('control plane points the panel at the other database when the URL is set', () => {
	assert.equal(controlTarget({ CONTROL_PLANE_DATABASE_URL: 'postgres://u:p@h/db' } as NodeJS.ProcessEnv), 'OFFICIAL');
});

test('panelSettings is the local service when no control database is configured', async () => {
	delete process.env.CONTROL_PLANE_DATABASE_URL;
	const { panelSettings } = await import('./control-plane-settings');
	const { systemSettingsService } = await import('./system-settings.service');
	const p = panelSettings();
	assert.equal(p.target, 'LOCAL');
	assert.equal(p.service, systemSettingsService);
	assert.equal(p.db, null);
});

test('identity and content panels stay on this deployment when no control database is configured', async () => {
	delete process.env.CONTROL_PLANE_DATABASE_URL;
	const { panelSiteIdentity, contentDb, requireActorInControlPlaneForWrites } = await import('./control-plane-settings');
	const { prisma } = await import('../config/db');
	assert.equal(panelSiteIdentity(), undefined);
	assert.equal(contentDb(), prisma);
	let called = 0;
	requireActorInControlPlaneForWrites({ method: 'PUT', user: { id: 'u' } } as never, {} as never, () => { called += 1; });
	assert.equal(called, 1); // nothing to check without a control database
});
