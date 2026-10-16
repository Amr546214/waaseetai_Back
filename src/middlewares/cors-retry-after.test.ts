import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The app's countdown reads `Retry-After`; a cross-origin browser only sees it when CORS exposes it.
test('static: the CORS config exposes the Retry-After header', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app.ts'), 'utf8');
  assert.match(src, /exposedHeaders:\s*\[[^\]]*'Retry-After'[^\]]*\]/);
});
