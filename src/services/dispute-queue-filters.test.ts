import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDisputeQueueFilters } from './dispute-queue-filters';

const parse = (q: Record<string, unknown>, canPickStaff = false) => parseDisputeQueueFilters(q, { canPickStaff });
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e: any) { return e.statusCode as number; } };

test('search is normalised (#, …, case) and bounded', () => {
	assert.equal(parse({ q: '#3F6FA186…' }).q, '3f6fa186');
	assert.equal(parse({ q: ' 3f6f ' }).q, '3f6f');
	assert.equal(parse({}).q, undefined); assert.equal(parse({ q: '  ' }).q, undefined);
	for (const bad of ['3f6', 'xyz123', 'a'.repeat(37), ['abcd', 'abcd'], { a: 1 }]) assert.equal(status(() => parse({ q: bad })), 400, String(bad));
});

test('assignee: me / unassigned for everyone, a staff id only with team.view, anything else 400', () => {
	const id = '4a3bbbba-95dd-45bd-be20-59b69a29fa2e';
	assert.deepEqual(parse({ assignee: 'ME' }).assignee, { kind: 'me' }); assert.deepEqual(parse({ assignee: 'unassigned' }).assignee, { kind: 'unassigned' });
	assert.equal(status(() => parse({ assignee: id })), 403); assert.deepEqual(parse({ assignee: id }, true).assignee, { kind: 'staff', id });
	assert.equal(status(() => parse({ assignee: 'x' }, true)), 400);
});

test('period: date-only bounds are whole UTC days, from <= to, max 366 days', () => {
	const f = parse({ createdFrom: '2024-02-29', createdTo: '2024-03-01' });
	assert.equal(f.createdFrom!.toISOString(), '2024-02-29T00:00:00.000Z'); assert.equal(f.createdTo!.toISOString(), '2024-03-01T23:59:59.999Z');
	assert.equal(parse({ createdFrom: '2024-03-01T10:00:00' }).createdFrom!.toISOString(), '2024-03-01T10:00:00.000Z');
	for (const bad of [{ createdFrom: '2023-02-29' }, { createdFrom: 'x' }, { createdFrom: '2024-03-02', createdTo: '2024-03-01' }, { createdFrom: '2020-01-01', createdTo: '2022-01-01' }]) assert.equal(status(() => parse(bad)), 400, JSON.stringify(bad));
});
