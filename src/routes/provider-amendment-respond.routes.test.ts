import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./provider.routes.ts', import.meta.url), 'utf8');
test('POST /provider/amendments/:id/respond is provider-only', () => {
	const line = src.split('\n').find((l) => l.includes("router.post('/amendments/:id/respond'"));
	assert.ok(line);
	assert.match(line!, /authenticate, requireActiveUser, providerOnly, providerProjectAmendmentsController\.respond/);
});
test('the provider controller takes the provider id from the token and the decision from the body only', () => {
	const c = readFileSync(new URL('../controllers/provider-project-amendments.controller.ts', import.meta.url), 'utf8');
	assert.match(c, /respondToAmendmentAsProvider\(userId, req\.params\.id as string, req\.body\?\.decision\)/);
	assert.doesNotMatch(c, /req\.body\.providerId|req\.body\.userId/);
});
