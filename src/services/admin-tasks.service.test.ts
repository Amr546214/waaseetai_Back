import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminTasksService } from './admin-tasks.service';

const actor: any = { userId: 'a1', permissions: new Set(['tasks.manage']), isSuperAdmin: true };
const rows = [
	{ id: 't-new', status: 'NEW' }, { id: 't-work', status: 'IN_PROGRESS' }, { id: 't-pend', status: 'PENDING' }, { id: 't-done', status: 'DONE' }, { id: 't-off', status: 'CANCELLED' },
];
/** Applies the status filter the service sends to Prisma, so the test checks which tasks each tab really returns. */
function service() {
	const seen: any[] = [];
	const db: any = { adminTask: { findMany: async (args: any) => {
		seen.push(args.where);
		const st = args.where.status;
		const pick = (r: { status: string }) => st === undefined || (typeof st === 'string' ? r.status === st : st.in.includes(r.status));
		return rows.filter(pick).map(r => ({ ...r, title: r.id, code: r.id, type: 'SUPPORT', priority: 'NORMAL', dueAt: null, createdAt: new Date(), updatedAt: new Date(), completedAt: null, assigneeId: null, assignee: null, version: 1, description: null, linkType: null, linkId: null, createdById: 'a1' }));
	} } };
	return { svc: new AdminTasksService(db, () => new Date('2026-11-06T12:00:00Z')), seen };
}
const ids = (r: any[]) => r.map(x => x.id).sort();

test('tasks list: the default «open» tab returns every open task (new, in progress, pending) — what the open counter counts', async () => {
	const { svc } = service();
	assert.deepEqual(ids(await svc.list(actor, { tab: 'open' })), ['t-new', 't-pend', 't-work']);
});
test('tasks list: «active» is only in-progress, «pending» keeps new + pending, «done» and «all» unchanged', async () => {
	const { svc } = service();
	assert.deepEqual(ids(await svc.list(actor, { tab: 'active' })), ['t-work']);
	assert.deepEqual(ids(await svc.list(actor, { tab: 'pending' })), ['t-new', 't-pend']);
	assert.deepEqual(ids(await svc.list(actor, { tab: 'done' })), ['t-done']);
	assert.equal((await svc.list(actor, { tab: '' })).length, 5);
});
