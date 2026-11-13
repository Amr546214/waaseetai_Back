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
	const saved = process.env.BACKUP_DIR; delete process.env.BACKUP_DIR; try { const b = (await svc.backups()).sections[0]; assert.match(b.unavailable!.requirement, /BACKUP_DIR/); } finally { if (saved) process.env.BACKUP_DIR = saved; }
});
test('database failures are reported as unavailable with the reason instead of fake numbers', async () => {
	const svc = new AdminInfrastructureService({ $queryRawUnsafe: async () => { throw new Error('connection refused'); } } as never);
	const d = await svc.database(); assert.equal(d.sections.length, 1); assert.match(d.sections[0].unavailable!.reason, /connection refused/);
});
test('without a configured backup agent the requirement names the real agent, not an audit-only restore', async () => {
 const saved=process.env.BACKUP_AGENT_URL;delete process.env.BACKUP_AGENT_URL;
 try { const b=await new AdminInfrastructureService({} as never).backups();assert.match(b.sections[0].unavailable!.requirement,/BACKUP_AGENT_URL/); } finally { if(saved)process.env.BACKUP_AGENT_URL=saved; }
});
