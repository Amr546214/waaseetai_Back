import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_CATALOG, allCatalogSkills } from './skills-catalog.config';

// Static guard: skills live in ONE place (src/config/skills-catalog.config.ts). No other source file may carry a hardcoded list of skill names,
// and no made-up fallback specialty label («تطوير وتصميم») may reach a user.
const SRC = path.join(__dirname, '..');
function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const full = path.join(dir, e.name);
		return e.isDirectory() ? walk(full) : /\.ts$/.test(e.name) ? [full] : [];
	});
}
const sources = walk(SRC).filter(f => !/\.test\.ts$/.test(f) && !f.endsWith(path.join('config', 'skills-catalog.config.ts')));

test('the catalog is non-empty and keyed by category slug', () => {
	assert.ok(Object.keys(SKILLS_CATALOG).length >= 15);
	assert.ok(allCatalogSkills().length > 100);
});

test('no hardcoded skill list outside the catalog file: no source file quotes 5 or more distinct catalog skill names', () => {
	const names = allCatalogSkills().filter(n => n.length >= 4);
	const offenders: string[] = [];
	for (const file of sources) {
		const text = fs.readFileSync(file, 'utf8');
		const hits = new Set(names.filter(n => text.includes(`'${n}'`) || text.includes(`"${n}"`)));
		if (hits.size >= 5) offenders.push(`${path.relative(SRC, file)}: ${[...hits].slice(0, 6).join(', ')}`);
	}
	assert.deepEqual(offenders, []);
});

test('the made-up fallback label «تطوير وتصميم» is not served to any user (no source file contains it)', () => {
	const offenders = sources.filter(f => fs.readFileSync(f, 'utf8').includes('تطوير وتصميم')).map(f => path.relative(SRC, f));
	assert.deepEqual(offenders, []);
});
