import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketEventsFor } from './settings-notice-events';

test('an identity notice announces identity:changed with a timestamp only', () => {
	assert.deepEqual(socketEventsFor({ keys: ['site_identity'], at: 5 }), [{ name: 'identity:changed', payload: { at: 5 } }]);
});
test('a taxonomy notice does not announce identity, and an unrelated key announces nothing', () => {
	assert.deepEqual(socketEventsFor({ keys: ['taxonomy'], revision: 3, at: 5 }).map(e => e.name), ['taxonomy:changed']);
	assert.deepEqual(socketEventsFor({ keys: ['maintenanceMode'], at: 5 }), []);
});
test('the resync notice (empty keys, sent after the listener reconnected) announces BOTH, so changes missed during the outage are re-read', () => {
	assert.deepEqual(socketEventsFor({ keys: [], at: 9 }).map(e => e.name), ['taxonomy:changed', 'identity:changed']);
});
test('payloads never carry keys, values or actors', () => {
	for (const e of socketEventsFor({ keys: ['site_identity', 'taxonomy'], revision: 1, at: 2 })) assert.deepEqual(Object.keys(e.payload).every(k => k === 'at' || k === 'revision'), true);
});
