import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard: normal CLIENT/PROVIDER/AFFILIATE users must receive 403
// from every route in this file. authorize()'s actual decision logic is
// already unit-tested generically in src/middlewares/auth.middleware.test.ts;
// this locks in that THIS router actually wires that guard in, the same
// static-source-check approach used for provider-profile.routes.ts's P0-2
// fix, since this codebase's test suite does not boot a real Express app.

const source = fs.readFileSync(path.join(__dirname, 'admin-affiliate-requests.routes.ts'), 'utf8');

test('admin-affiliate-requests router is gated by authenticate + requireActiveUser + authorize(ADMIN, SUPER_ADMIN)', () => {
	assert.match(source, /router\.use\(authenticate,\s*requireActiveUser,\s*authorize\(AccountType\.ADMIN,\s*AccountType\.SUPER_ADMIN\)\)/);
});

test('all four expected routes are registered', () => {
	assert.match(source, /router\.get\('\/',\s*adminAffiliateRequestsController\.listRequests\)/);
	assert.match(source, /router\.get\('\/:id',\s*adminAffiliateRequestsController\.getRequest\)/);
	assert.match(source, /router\.post\('\/:id\/approve',\s*adminAffiliateRequestsController\.approve\)/);
	assert.match(source, /router\.post\('\/:id\/reject',\s*adminAffiliateRequestsController\.reject\)/);
});
