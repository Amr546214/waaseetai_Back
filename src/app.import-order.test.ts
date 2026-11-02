import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// tsc emits CommonJS `require`s in source order: an import written BELOW the code that uses it compiles to "Cannot access 'x_1' before initialization" and the server never starts
// (found on the first real dev build of the settings batch; the tsx-based tests do not hoist the same way).
test('app.ts: every imported name appears in an import above its first use', () => {
	const lines = readFileSync(join(__dirname, 'app.ts'), 'utf8').split('\n');
	const imports: Array<{ name: string; line: number }> = [];
	lines.forEach((l, i) => {
		const m = l.match(/^import\s+(.+?)\s+from\s+'[^']+';/); if (!m) return;
		for (const part of m[1].replace(/[{}]/g, ',').split(',')) { const n = part.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) imports.push({ name: n, line: i }); }
	});
	const bad: string[] = [];
	for (const { name, line } of imports) {
		const use = lines.findIndex((l, i) => i !== line && !/^import\s/.test(l) && !/^\s*\/\//.test(l) && new RegExp(`(^|[^\\w$.])${name.replace('$', '\\$')}([^\\w$]|$)`).test(l));
		if (use !== -1 && use < line) bad.push(`${name}: used on line ${use + 1}, imported on line ${line + 1}`);
	}
	assert.deepEqual(bad, []);
});
