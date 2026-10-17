import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Declining a counter sits next to the accept route: authenticated, active user, client accounts only (same guard as accept); the owner comes from the token.
const src = readFileSync(new URL('./client-requests.routes.ts', import.meta.url), 'utf8');
test('POST /:id/offers/:offerId/counter/decline is client-only like accept', () => {
	const line = src.split('\n').find((l) => l.includes("router.post('/:id/offers/:offerId/counter/decline'"));
	assert.ok(line, 'route registered');
	assert.match(line!, /authenticate, requireActiveUser, authorizeActiveRole\(AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\), clientRequestsController\.declineOfferCounter/);
});
test('the decline controller takes the client id from the token only', () => {
	const c = readFileSync(new URL('../controllers/client-requests.controller.ts', import.meta.url), 'utf8');
	const block = c.slice(c.indexOf('public async declineOfferCounter'), c.indexOf('public async signContract'));
	assert.match(block, /req\.user!\.userId \|\| req\.user!\.id/);
	assert.doesNotMatch(block, /req\.body\.userId|req\.body\.clientId/);
});
