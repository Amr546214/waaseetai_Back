import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminInfrastructureService, containerSection, diskSection, hostSection, runtimeSection } from './admin-infrastructure.service';

test('every section states its source, scope and measurement time; container and host figures are separate sections', () => {
	for (const s of [runtimeSection({ engine: { clientsCount: 3 } }), containerSection(), hostSection(), diskSection()]) { assert.ok(s.source && s.scope && !Number.isNaN(Date.parse(s.measuredAt)), s.title); assert.ok(s.items || s.unavailable || s.table, s.title); }
	assert.equal(runtimeSection({ engine: { clientsCount: 3 } }).items!.find(i => i.label.startsWith('اتصالات Socket.IO'))!.value, 3);
	assert.equal(containerSection().source, 'container'); assert.equal(hostSection().source, 'host');
});
test('no source = unavailable with the NAMED requirement, never a sample number (CDN, backups without BACKUP_DIR)', async () => {
	const svc = new AdminInfrastructureService({ $queryRawUnsafe: async () => { throw new Error('no table'); } } as never);
	const cdn = await svc.cdn(); const cdnSec = cdn.sections.find(s => s.title.includes('CDN'))!; assert.match(cdnSec.unavailable!.requirement, /CDN_API_TOKEN/); assert.equal(cdnSec.items, undefined);
	const saved = process.env.BACKUP_DIR; delete process.env.BACKUP_DIR; try { const b = svc.backups().sections[0]; assert.match(b.unavailable!.requirement, /BACKUP_DIR/); } finally { if (saved) process.env.BACKUP_DIR = saved; }
});
test('database failures are reported as unavailable with the reason instead of fake numbers', async () => {
	const svc = new AdminInfrastructureService({ $queryRawUnsafe: async () => { throw new Error('connection refused'); } } as never);
	const d = await svc.database(); assert.equal(d.sections.length, 1); assert.match(d.sections[0].unavailable!.reason, /connection refused/);
});
test('backups reads the configured directory read-only, newest first', async () => {
	const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); fs.writeFileSync(path.join(dir, 'a.dump'), 'x'); await new Promise(r => setTimeout(r, 15)); fs.writeFileSync(path.join(dir, 'b.dump'), 'yy');
	process.env.BACKUP_DIR = dir; try { const t = new AdminInfrastructureService({} as never).backups().sections[0].table!; assert.equal(t.rows[0][0], 'b.dump'); assert.equal(t.rows.length, 2); } finally { delete process.env.BACKUP_DIR; fs.rmSync(dir, { recursive: true }); }
});
