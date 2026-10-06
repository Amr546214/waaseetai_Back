import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// AUD-FND-000035 — client/profile and marketer/profile were guarded by authenticate only, so a SUSPENDED account (or one still
// awaiting OTP activation) holding a valid token kept full access. Source-level wiring check, same approach as
// provider-profile.routes.test.ts: requireActiveUser must be applied right after authenticate, and the public route must stay before it.
function read(file: string) {
	return fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
}

for (const [file, publicRoute] of [['client-profile.routes.ts', "router.get('/public/:id'"], ['marketer-profile.routes.ts', "router.get('/public/:id'"]] as const) {
	test(`${file}: requireActiveUser is imported and applied after authenticate`, () => {
		const lines = read(file);
		const importLine = lines.find(l => l.startsWith('import') && l.includes('middlewares/auth.middleware'));
		assert.ok(importLine?.includes('requireActiveUser'), 'requireActiveUser must be imported from auth.middleware');
		const authIdx = lines.findIndex(l => /router\.use\(authenticate/.test(l));
		assert.ok(authIdx >= 0, 'an authenticate guard exists');
		const activeIdx = lines.findIndex((l, i) => i >= authIdx && l.includes('requireActiveUser') && /router\.use\(/.test(l));
		assert.ok(activeIdx >= authIdx, 'requireActiveUser is applied from the authenticate guard onwards');
	});

	test(`${file}: the public profile route stays before the guards (still public)`, () => {
		const lines = read(file);
		const publicIdx = lines.findIndex(l => l.includes(publicRoute));
		const guardIdx = lines.findIndex(l => l.includes('requireActiveUser') && /router\.use\(/.test(l));
		assert.ok(publicIdx >= 0 && guardIdx >= 0 && publicIdx < guardIdx);
	});
}
