import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// The legal name is private: only the registration path, the owner's own endpoint and the reviewers' identity view may mention it.
// A new file that starts to read or return it must be added here deliberately, after checking it is not a public / chat / search / notification surface.
const ALLOWED = new Set([
	'src/routes/auth/auth.schema.ts', 'src/repositories/auth.repository.ts', 'src/utils/legal-name.ts', 'src/services/legal-name.service.ts',
	'src/controllers/legal-name.controller.ts', 'src/services/identity-field-check.service.ts', 'src/utils/profile-request-categories.ts', 'src/services/provider-profile.service.ts',
	'src/app.ts', 'src/routes/legal-name.routes.ts' // route mount only
]);
test('legalName appears only in the allow-listed (non-public) source files', () => {
	const out = execFileSync('git', ['grep', '-l', 'legalName', '--', 'src', ':!*.test.ts', ':!src/testing'], { encoding: 'utf8' }).split('\n').filter(Boolean);
	const extra = out.filter(f => !ALLOWED.has(f));
	assert.deepEqual(extra, [], `unexpected use of legalName in: ${extra.join(', ')}`);
});
