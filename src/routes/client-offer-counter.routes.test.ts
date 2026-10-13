import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The counter routes are client-only: authenticate + requireActiveUser + the client account-type guard (a provider token is 403 from `authorize`).
const src = readFileSync(new URL('./client-requests.routes.ts', import.meta.url), 'utf8');
for (const [method, path, handler] of [['get', '/:id/offers/:offerId/counter', 'getOfferCounter'], ['post', '/:id/offers/:offerId/counter/accept', 'acceptOfferCounter']]) {
	test(`${method.toUpperCase()} ${path} is client-only`, () => {
		const line = src.split('\n').find((l) => l.includes(`router.${method}('${path}'`));
		assert.ok(line, 'route registered');
		assert.match(line!, /authenticate, requireActiveUser, authorize\(AccountType\.CLIENT_COMPANY, AccountType\.CLIENT_INDIVIDUAL\), clientRequestsController\./);
		assert.ok(line!.includes(`clientRequestsController.${handler}`));
	});
}
test('the controller takes the client id from the token only', () => {
	const c = readFileSync(new URL('../controllers/client-requests.controller.ts', import.meta.url), 'utf8');
	const block = c.slice(c.indexOf('acceptOfferCounter'), c.indexOf('acceptOfferCounter') + 500);
	assert.match(block, /req\.user!\.userId \|\| req\.user!\.id/);
	assert.doesNotMatch(block, /req\.body\.userId/);
});
