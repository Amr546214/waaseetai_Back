import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/** Level identity on REAL PostgreSQL over HTTP: permissions, version conflict, validation, audit row, bus notice, persistence across a "restart" (refresh from the row). Isolated local database only. */
after(async () => { await closeEnv(); });
const opened: Array<() => Promise<void>> = [];
after(async () => { for (const c of opened) await c().catch(() => undefined); });

async function mount(e: any) {
	const express = (await import('express')).default; const { globalErrorHandler } = await import('../middlewares/error.middleware');
	const { buildAdminLevelIdentityRouter } = await import('../routes/admin-level-identity.routes'); const { LevelIdentityService } = await import('./level-identity.service');
	const service = new LevelIdentityService(e.prisma);
	const app = express(); app.use(express.json()); app.use('/admin/level-identity', buildAdminLevelIdentityRouter(service)); app.use(globalErrorHandler);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	opened.push(() => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = async (method: string, who: string | null, body?: unknown) => { const res = await fetch(base + '/admin/level-identity', { method, headers: { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) as any }; };
	return { call, service };
}

test('PG level identity: permissions, save, conflict, validation, audit, bus notice, persistence', opts, async () => {
	const e = await env(); const m = await mount(e); const sa = e.sa.id;
	await e.prisma.platformSetting.deleteMany({ where: { key: 'levelIdentity' } });
	const { applyLevelOverrides, defaultLevelName } = await import('../config/levels.config'); applyLevelOverrides({});
	const viewer = (await mkStaff(e, ['site.view'], 'lv')).user, manager = (await mkStaff(e, ['site.manage'], 'lm')).user, legacy = (await mkStaff(e, ['site_control.manage'], 'll')).user, other = (await mkStaff(e, ['users.view'], 'lo')).user;
	const change = [{ role: 'PROVIDER', level: 4, name: 'بارع جدًا', dark: '#11AA55' }];
	// permissions: anonymous 401, no site permission 403, view-only reads but cannot write, manage / legacy / super write
	assert.equal((await m.call('GET', null)).status, 401); assert.equal((await m.call('GET', other.id)).status, 403);
	const v0 = await m.call('GET', viewer.id); assert.equal(v0.status, 200); assert.equal(v0.json.data.version, 0); assert.equal(v0.json.data.rows.length, 45);
	assert.equal((await m.call('PUT', viewer.id, { expectedVersion: 0, changes: change })).status, 403); assert.equal((await m.call('PUT', other.id, { expectedVersion: 0, changes: change })).status, 403);
	// validation before anything is stored
	assert.equal((await m.call('PUT', sa, { expectedVersion: 0, changes: [{ role: 'PROVIDER', level: 4, dark: 'red' }] })).status, 400);
	assert.equal((await m.call('PUT', sa, { expectedVersion: 0, changes: [{ role: 'PROVIDER', level: 4, name: 'مبتدئ' }] })).status, 400);
	assert.equal((await m.call('PUT', sa, { changes: change })).status, 400, 'expectedVersion is required');
	assert.equal(await e.prisma.platformSetting.count({ where: { key: 'levelIdentity' } }), 0);
	// a notice is published (keys only) when a save commits
	const { onSettingsNotice, startSettingsListener, stopSettingsListener } = await import('./settings-bus'); const seen: any[] = []; const off = onSettingsNotice(n => { seen.push(n); }); startSettingsListener(); await new Promise(r => setTimeout(r, 500));
	const saved = await m.call('PUT', manager.id, { expectedVersion: 0, changes: change });
	assert.equal(saved.status, 200, JSON.stringify(saved.json)); assert.equal(saved.json.data.version, 1);
	const row = saved.json.data.rows.find((r: any) => r.role === 'PROVIDER' && r.level === 4); assert.equal(row.name, 'بارع جدًا'); assert.equal(row.color.dark, '#11AA55'); assert.equal(row.defaultName, 'بارع'); assert.deepEqual(row.overridden, { name: true, dark: true, light: false });
	await new Promise(r => setTimeout(r, 500)); off(); stopSettingsListener();
	assert.ok(seen.some(n => Array.isArray(n.keys) && n.keys.includes('levelIdentity')), 'the bus announced the key'); assert.ok(seen.every(n => !JSON.stringify(n).includes('بارع')), 'the notice carries no values');
	// audit row: who, before -> after
	const log = await e.prisma.accountAuditLog.findFirst({ where: { eventType: 'LEVEL_IDENTITY_UPDATED' }, orderBy: { occurredAt: 'desc' } });
	assert.equal(log?.userId, manager.id); assert.deepEqual(log?.beforeData, {}); assert.equal((log?.afterData as any).PROVIDER['4'].name, 'بارع جدًا');
	// stale version -> 409 with the winner's state; nothing overwritten
	const stale = await m.call('PUT', legacy.id, { expectedVersion: 0, changes: [{ role: 'PROVIDER', level: 4, name: 'اسم آخر' }] });
	assert.equal(stale.status, 409); assert.equal(stale.json.code, 'LEVEL_IDENTITY_VERSION_CONFLICT'); assert.equal(stale.json.current.version, 1);
	assert.equal(stale.json.current.rows.find((r: any) => r.role === 'PROVIDER' && r.level === 4).name, 'بارع جدًا');
	// "restart": the in-memory state is gone, the row brings it back
	applyLevelOverrides({}); assert.equal(defaultLevelName('PROVIDER', 4), 'بارع'); await m.service.refresh();
	const again = await m.call('GET', viewer.id); assert.equal(again.json.data.rows.find((r: any) => r.role === 'PROVIDER' && r.level === 4).name, 'بارع جدًا');
	// back to the default through null, with the right version
	const reset = await m.call('PUT', sa, { expectedVersion: 1, changes: [{ role: 'PROVIDER', level: 4, name: null, dark: null }] });
	assert.equal(reset.status, 200); assert.equal(reset.json.data.rows.find((r: any) => r.role === 'PROVIDER' && r.level === 4).name, 'بارع'); assert.equal(reset.json.data.version, 2);
	// an unchanged save is refused (no empty versions)
	assert.equal((await m.call('PUT', sa, { expectedVersion: 2, changes: [{ role: 'PROVIDER', level: 4, name: null }] })).status, 400);
	applyLevelOverrides({});
});
