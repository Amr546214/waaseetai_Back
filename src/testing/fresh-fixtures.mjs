import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Test-only preload. Query strings create fresh ESM wrappers, but tsx's
// CommonJS source modules also need their require.cache entry invalidated.
// Normal imports and application startup keep their existing singleton state.
if (!process.env.NODE_TEST_CONTEXT && !process.execArgv.includes('--test')) {
  throw new Error('fresh-fixtures.mjs is only for node --test');
}
const require = createRequire(import.meta.url);
const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url))) + path.sep;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('file:') && result.url.includes('?')) {
      const url = new URL(result.url);
      if (url.search && /\.(?:ts|js)$/.test(url.pathname)) {
        url.search = '';
        const filename = fileURLToPath(url);
        if (filename.startsWith(sourceRoot)) delete require.cache[filename];
      }
    }
    return result;
  }
});
