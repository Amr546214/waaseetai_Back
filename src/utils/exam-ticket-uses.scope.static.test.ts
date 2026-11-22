import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The unit tests of the SEB handshake replace the storage with a mock, so they could not see that the REAL table refuses the scope the code writes.
// This reads the migrations in order and checks that the CHECK on exam_ticket_uses.scope that is finally in force allows every scope the code claims.

const root = join(__dirname, '..', '..');
const CODE_SCOPES = ['SETUP_TEST', 'SEB_JS_CHALLENGE'];

function finalScopeCheck(): string[] {
	const dir = join(root, 'prisma', 'migrations');
	let allowed: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		let sql = ''; try { sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8'); } catch { continue; }
		if (!/exam_ticket_uses/.test(sql)) continue;
		const check = [...sql.matchAll(/CHECK\s*\(\s*"scope"\s*(?:=\s*'([A-Z_]+)'|IN\s*\(([^)]*)\))\s*\)/g)].pop();
		if (check) allowed = check[1] ? [check[1]] : [...check[2].matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
	}
	return allowed;
}

test('the scopes the exam code claims are all allowed by the CHECK that the migrations leave on exam_ticket_uses', () => {
	const allowed = finalScopeCheck();
	for (const scope of CODE_SCOPES) assert.ok(allowed.includes(scope), `exam_ticket_uses.scope CHECK does not allow ${scope} (allowed: ${allowed.join(', ')})`);
});

test('the code really claims those scopes (guards this test against going stale)', () => {
	const src = readFileSync(join(root, 'src', 'utils', 'exam-ticket.ts'), 'utf8') + readFileSync(join(root, 'src', 'utils', 'seb-js-proof.ts'), 'utf8');
	for (const scope of CODE_SCOPES) assert.ok(src.includes(`'${scope}'`), scope);
});
