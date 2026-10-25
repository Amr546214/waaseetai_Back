import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Mail links get their host ONLY from utils/site-url. A new `process.env.FRONTEND_URL` next to a link would bring the host-less (broken) links back.
const ALLOWED = new Set(['utils/site-url.ts', 'app.ts' /* CORS origin list */, 'services/marketer-overview.service.ts' /* an API field, not a mail link */]);
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('no mail builder reads FRONTEND_URL directly', () => {
	const root = path.join(__dirname, '..');
	const offenders = walk(root).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.pgenv.ts') /* test harness, never shipped */).filter(f => fs.readFileSync(f, 'utf8').includes('process.env.FRONTEND_URL')).map(f => path.relative(root, f)).filter(f => !ALLOWED.has(f));
	assert.deepEqual(offenders, []);
});
