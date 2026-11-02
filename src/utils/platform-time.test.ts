import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInZone, instantOfWallClock, startOfDayInZone, startOfMonthInZone, startOfPreviousMonthInZone, zonedParts } from './platform-time';

test('platform time: month / day are cut in the zone, stored instants stay UTC, and the text is written in the zone', () => {
	const now = new Date('2026-10-15T10:00:00Z');
	assert.equal(startOfMonthInZone('UTC', now).toISOString(), '2026-10-01T00:00:00.000Z');
	assert.equal(startOfMonthInZone('Asia/Riyadh', now).toISOString(), '2026-09-30T21:00:00.000Z'); // 1 Oct 00:00 in GMT+3
	assert.equal(startOfPreviousMonthInZone('Asia/Riyadh', now).toISOString(), '2026-08-31T21:00:00.000Z');
	assert.equal(startOfDayInZone('Asia/Riyadh', new Date('2026-10-15T22:30:00Z')).toISOString(), '2026-10-15T21:00:00.000Z'); // 16 Oct 01:30 Riyadh -> its day began 15 Oct 21:00Z
	assert.equal(startOfDayInZone('UTC', new Date('2026-10-15T22:30:00Z')).toISOString(), '2026-10-15T00:00:00.000Z');
	assert.deepEqual(zonedParts(new Date('2026-12-31T22:00:00Z'), 'Asia/Riyadh'), { year: 2027, month: 1, day: 1, hour: 1, minute: 0, second: 0 }); // year rolls over
	assert.equal(formatInZone(new Date('2026-10-25T18:30:00Z'), 'Asia/Riyadh'), '2026-10-25 21:30'); assert.equal(formatInZone(new Date('2026-10-25T18:30:00Z'), 'UTC', false), '2026-10-25');
	assert.equal(instantOfWallClock('Asia/Riyadh', 2026, 10, 1, 0, 0, 0).toISOString(), '2026-09-30T21:00:00.000Z');
	assert.equal(startOfMonthInZone('Asia/Riyadh', new Date('2026-09-30T21:00:00Z')).toISOString(), '2026-09-30T21:00:00.000Z', 'the first instant of the month belongs to that month');
	assert.equal(startOfMonthInZone('Asia/Riyadh', new Date('2026-09-30T20:59:59Z')).toISOString(), '2026-08-31T21:00:00.000Z', 'one second before it belongs to the previous month');
});
