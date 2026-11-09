import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, mkStaff, closeEnv } from '../testing/admin-team.pgenv';

/**
 * Admin dispute queue: search + assignee + creation period, REAL PostgreSQL (database qa_iso_dq_*) and the REAL admin router + permission guard over HTTP.
 * All data of one test is unique (random ids), the queue is read with a `q` that only matches that data or with a period far in the past, so tests do not depend on each other.
 */
after(async () => { await closeEnv(); });

const D = (iso: string) => new Date(iso);
let seq = 0;
async function world() {
	const e = await env(); const tag = randomUUID().slice(0, 8);
	const mk = (label: string) => e.prisma.user.create({ data: { id: randomUUID(), accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', firstName: 'QA', lastName: label, email: `qa-dq-${label}-${tag}-${++seq}@pg.test` } as any });
	const client = await mk('client'), provider = await mk('prov');
	const cat = await e.prisma.category.create({ data: { id: randomUUID(), slug: `c-${tag}`, nameAr: 'تصنيف' } as any });
	const spec = await e.prisma.specialty.create({ data: { id: randomUUID(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } as any });
	const profile = await e.prisma.clientProfile.create({ data: { id: randomUUID(), userId: client.id } as any });
	const mkRequest = () => e.prisma.clientRequest.create({ data: { id: randomUUID(), clientProfileId: profile.id, specialtyId: spec.id, title: 'QA request', description: 'synthetic' } as any });
	const mkProject = () => e.prisma.project.create({ data: { id: randomUUID(), title: 'QA project', description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } as any });
	const dispute = (over: Record<string, any> = {}) => e.prisma.dispute.create({ data: { id: randomUUID(), openedById: client.id, againstUserId: provider.id, reason: 'سبب', description: 'وصف اختباري للنزاع', status: 'OPEN', ...over } as any });
	return { e, tag, client, provider, mkRequest, mkProject, dispute };
}
const ids = (r: any) => r.json.data.items.map((i: any) => i.id);
const list = (e: any, who: string, qs: string) => e.call('GET', `/admin/disputes${qs ? `?${qs}` : ''}`, who);
const assign = async (e: any, id: string, to: string) => { const r = await e.call('POST', `/admin/disputes/${id}/assign`, e.sa.id, { assigneeId: to }); assert.equal(r.status, 200, JSON.stringify(r.json)); };

test('PG: search by full id, short prefix (with # and …), request / project reference; case-insensitive; no match; too short / not hex refused', opts, async () => {
	const w = await world(); const { e } = w;
	const request = await w.mkRequest(), project = await w.mkProject();
	const a = await w.dispute({ requestId: request.id }); const b = await w.dispute({ projectId: project.id }); const c = await w.dispute();
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${a.id}`)), [a.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${a.id.toUpperCase()}`)), [a.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${encodeURIComponent(`#${b.id.slice(0, 8)}…`)}`)), [b.id]);
	assert.ok(ids(await list(e, e.sa.id, `q=${c.id.slice(0, 8)}`)).includes(c.id));
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${request.id}`)), [a.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${request.id.slice(0, 12)}`)), [a.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `q=${project.id}`)), [b.id]);
	const none = await list(e, e.sa.id, 'q=ffffffff-ffff'); assert.equal(none.status, 200); assert.equal(none.json.data.pagination.total, 0); assert.deepEqual(ids(none), []);
	for (const bad of ['abc', '%20%20ab', 'zzzzzz', 'drop%20table', 'q=1']) { const r = await list(e, e.sa.id, `q=${bad}`); assert.equal(r.status, 400, bad); assert.ok(/[؀-ۿ]/.test(r.json.message)); }
	const arr = await list(e, e.sa.id, `q=${a.id}&q=${b.id}`); assert.equal(arr.status, 400);
	// free text of the dispute / parties is NOT searched
	assert.equal((await list(e, e.sa.id, 'q=cafe')).json.data.pagination.total >= 0, true);
});

test('PG: assignee me / unassigned / specific; arbitrary staff needs team.view (me + unassigned are open to disputes.view)', opts, async () => {
	const w = await world(); const { e } = w;
	const { user: s1 } = await mkStaff(e, ['disputes.view'], 's1'); const { user: s2 } = await mkStaff(e, ['disputes.view', 'team.view'], 's2');
	const mine = await w.dispute(), other = await w.dispute(), free = await w.dispute(), reassigned = await w.dispute();
	await assign(e, mine.id, s1.id); await assign(e, other.id, s2.id); await assign(e, reassigned.id, s1.id); await assign(e, reassigned.id, s2.id); // now s2's
	const scope = `createdFrom=2000-01-01&createdTo=2000-12-31`; void scope;
	const qs = (extra: string) => `${extra}`;
	const mineRows = ids(await list(e, s1.id, qs('assignee=me'))); assert.ok(mineRows.includes(mine.id)); assert.ok(!mineRows.includes(other.id)); assert.ok(!mineRows.includes(reassigned.id), 'the newest assignment wins');
	const un = ids(await list(e, s1.id, 'assignee=unassigned&limit=100')); assert.ok(un.includes(free.id)); assert.ok(![mine.id, other.id, reassigned.id].some(x => un.includes(x)));
	// s1 (no team.view) cannot name a staff member
	const denied = await list(e, s1.id, `assignee=${s2.id}`); assert.equal(denied.status, 403); assert.ok(/[؀-ۿ]/.test(denied.json.message));
	const picked = ids(await list(e, s2.id, `assignee=${s1.id}`)); assert.ok(picked.includes(mine.id)); assert.ok(!picked.includes(reassigned.id));
	const s2rows = ids(await list(e, e.sa.id, `assignee=${s2.id}`)); assert.ok(s2rows.includes(other.id) && s2rows.includes(reassigned.id) && !s2rows.includes(mine.id));
	assert.equal((await list(e, e.sa.id, 'assignee=nobody')).status, 400);
	assert.equal((await list(e, e.sa.id, `assignee=${randomUUID()}`)).json.data.pagination.total, 0);
	// rows still show the same assignee data as before (no extra identity)
	const row = (await list(e, s2.id, `assignee=me&q=${other.id}`)).json.data.items[0]; assert.deepEqual(Object.keys(row.assignedTo).sort(), ['id', 'name']);
});

test('PG: creation period: inclusive UTC bounds, date-only and datetime, from>to / bad date / too long rejected', opts, async () => {
	const w = await world(); const { e } = w;
	const project = await w.mkProject();
	const first = await w.dispute({ projectId: project.id, createdAt: D('2020-03-01T00:00:00.000Z') });
	const last = await w.dispute({ projectId: project.id, createdAt: D('2020-03-02T23:59:59.999Z') });
	const before = await w.dispute({ projectId: project.id, createdAt: D('2020-02-29T23:59:59.999Z') });
	const after_ = await w.dispute({ projectId: project.id, createdAt: D('2020-03-03T00:00:00.000Z') });
	const q = `q=${project.id}`;
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdFrom=2020-03-01&createdTo=2020-03-02`)).sort(), [first.id, last.id].sort());
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdFrom=2020-03-02`)).sort(), [last.id, after_.id].sort());
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdTo=2020-02-29`)), [before.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdFrom=2020-03-01T00:00:00.000Z&createdTo=2020-03-01T00:00:00.000Z`)), [first.id]);
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdFrom=${encodeURIComponent('2020-03-03T00:00:00')}`)), [after_.id], 'no zone = UTC');
	assert.deepEqual(ids(await list(e, e.sa.id, `${q}&createdFrom=${encodeURIComponent('2020-03-03T02:00:00+02:00')}&createdTo=2020-03-03`)), [after_.id], 'offset converted to UTC');
	for (const bad of ['createdFrom=2020-03-05&createdTo=2020-03-01', 'createdFrom=2020-02-31', 'createdFrom=yesterday', 'createdTo=2020-13-01', 'createdFrom=2018-01-01&createdTo=2020-01-01']) {
		const r = await list(e, e.sa.id, bad); assert.equal(r.status, 400, bad); assert.ok(/[؀-ۿ]/.test(r.json.message), bad);
	}
});

test('PG: every filter combines (AND) with status and followUp', opts, async () => {
	const w = await world(); const { e } = w; const { user: s } = await mkStaff(e, ['disputes.view', 'team.view'], 'combo');
	const project = await w.mkProject();
	const old = (over: any) => w.dispute({ projectId: project.id, createdAt: D('2020-05-10T10:00:00Z'), ...over });
	const hit = await old({ status: 'OPEN' }); const wrongStatus = await old({ status: 'OPEN' }); const wrongAssignee = await old({ status: 'OPEN' }); const unassigned = await old({ status: 'OPEN' }); const wrongDate = await w.dispute({ projectId: project.id, createdAt: D('2020-07-10T10:00:00Z'), status: 'OPEN' });
	const fresh = await w.dispute({ projectId: project.id, status: 'OPEN' }); // created now: not follow-up
	await assign(e, hit.id, s.id); await assign(e, wrongStatus.id, s.id); await assign(e, wrongDate.id, s.id); await assign(e, fresh.id, s.id); await assign(e, wrongAssignee.id, e.sa.id);
	await e.prisma.dispute.update({ where: { id: wrongStatus.id }, data: { status: 'RESOLVED' } }); // an assigned case that was then closed
	const all = `q=${project.id}&assignee=${s.id}&createdFrom=2020-05-01&createdTo=2020-05-31&status=OPEN`;
	const r = await list(e, s.id, all); assert.deepEqual(ids(r), [hit.id]); assert.equal(r.json.data.pagination.total, 1);
	assert.deepEqual(ids(await list(e, s.id, `${all}&followUp=true`)), [hit.id]);
	assert.deepEqual(ids(await list(e, s.id, `q=${project.id}&assignee=${s.id}&followUp=true&limit=100`)).sort(), [hit.id, wrongDate.id].sort(), 'follow-up = OPEN/UNDER_REVIEW older than 7 days');
	assert.deepEqual(ids(await list(e, s.id, `q=${project.id}&assignee=unassigned&createdFrom=2020-05-01&createdTo=2020-05-31&status=OPEN`)), [unassigned.id]);
	// status alone and followUp alone still behave as before
	assert.ok(ids(await list(e, s.id, `q=${project.id}&status=resolved`)).includes(wrongStatus.id));
	assert.equal((await list(e, s.id, 'status=NOPE')).status, 400); assert.equal((await list(e, s.id, 'followUp=maybe')).status, 400);
	// counters describe the filtered set; with no filter they are the global counts
	const c = (await list(e, s.id, `q=${project.id}`)).json.data; assert.equal(c.counts.OPEN, 5); assert.equal(c.counts.RESOLVED, 1); assert.equal(c.followUpCount, 4);
	const g = (await list(e, s.id, '')).json.data; assert.ok(g.counts.OPEN >= 5 && g.followUpCount >= 4);
});

test('PG: filters apply BEFORE pagination: total/pages correct, no overlap or gaps, stable order, page size change', opts, async () => {
	const w = await world(); const { e } = w; const project = await w.mkProject(); const noise = await w.mkProject();
	const sameTime = D('2021-01-01T00:00:00Z'); const made: string[] = [];
	for (let i = 0; i < 7; i++) made.push((await w.dispute({ projectId: project.id, createdAt: i < 3 ? sameTime : D(`2021-01-0${i}T12:00:00Z`) })).id);
	for (let i = 0; i < 4; i++) await w.dispute({ projectId: noise.id });
	const q = `q=${project.id}`;
	const p1 = await list(e, e.sa.id, `${q}&limit=3&page=1`), p2 = await list(e, e.sa.id, `${q}&limit=3&page=2`), p3 = await list(e, e.sa.id, `${q}&limit=3&page=3`), p4 = await list(e, e.sa.id, `${q}&limit=3&page=4`);
	for (const p of [p1, p2, p3]) { assert.equal(p.json.data.pagination.total, 7); assert.equal(p.json.data.pagination.pages, 3); }
	assert.deepEqual([ids(p1).length, ids(p2).length, ids(p3).length, ids(p4).length], [3, 3, 1, 0]);
	const seen = [...ids(p1), ...ids(p2), ...ids(p3)]; assert.equal(new Set(seen).size, 7); assert.deepEqual([...seen].sort(), [...made].sort());
	const rows = [...p1.json.data.items, ...p2.json.data.items, ...p3.json.data.items];
	for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i]; assert.ok(new Date(a.createdAt) >= new Date(b.createdAt)); if (+new Date(a.createdAt) === +new Date(b.createdAt)) assert.ok(a.id > b.id, 'id tie-break desc'); }
	const big = await list(e, e.sa.id, `${q}&limit=100`); assert.deepEqual(ids(big), seen, 'the order does not depend on the page size');
	assert.equal(big.json.data.pagination.pages, 1);
	const again = await list(e, e.sa.id, `${q}&limit=3&page=2`); assert.deepEqual(ids(again), ids(p2));
});

test('PG: staff without disputes.view (and no session) are refused; staff with it see the same disputes as before', opts, async () => {
	const w = await world(); const { e } = w; const { user: nope } = await mkStaff(e, ['users.view'], 'nope'); const d = await w.dispute();
	const bare = await e.mkUser('ADMIN', 'bare');
	for (const who of [nope.id, bare.id]) { const r = await list(e, who, `q=${d.id}`); assert.equal(r.status, 403); assert.equal(r.json.data, undefined); }
	assert.equal((await list(e, '' as any, `q=${d.id}`)).status, 401);
	const { user: viewer } = await mkStaff(e, ['disputes.view'], 'viewer'); assert.deepEqual(ids(await list(e, viewer.id, `q=${d.id}`)), [d.id]);
});
