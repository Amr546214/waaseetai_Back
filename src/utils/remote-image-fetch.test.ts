import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Image preparation / SSRF-hardening tests for remote-image-fetch.ts.
// No test ever accesses the real internet or performs a real DNS query:
// - Tests that are rejected before any network activity (bad protocol,
//   localhost, IP-literal private ranges) run the real module directly.
// - Tests that need a *hostname* to resolve mock `node:dns/promises` via
//   t.mock.module (verified to work for this built-in module the same way
//   it works for our own modules) and re-import the module fresh so the
//   mock is in effect.
// - Tests that need to control the actual HTTP response mock the global
//   `fetch` via t.mock.method, which node:test auto-restores after each
//   test regardless of module caching.

function mockDns(t: TestContext, addresses: string[]) {
  t.mock.module('node:dns/promises', {
    namedExports: {
      lookup: async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    }
  });
}

async function loadModule(t: TestContext) {
  const moduleUrl = `./remote-image-fetch.ts?fixture=${Date.now()}-${Math.random()}`;
  return import(moduleUrl) as Promise<typeof import('./remote-image-fetch')>;
}

function fakeImageResponse(opts: {
  status?: number;
  contentType?: string;
  contentLength?: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength;
  return new Response(opts.body ? opts.body : null, { status: opts.status ?? 200, headers });
}

// ── rejected before any network activity — no mocking needed ─────────────

test('fetchRemoteImage: rejects an invalid protocol (ftp) without any network call', async (t) => {
  const { fetchRemoteImage, RemoteImageFetchError } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('ftp://example.com/file.png'),
    (err: any) => { assert.ok(err instanceof RemoteImageFetchError); assert.equal(err.code, 'INVALID_PROTOCOL'); return true; }
  );
});

test('fetchRemoteImage: rejects a malformed URL string', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('not a url at all'),
    (err: any) => { assert.equal(err.code, 'INVALID_URL'); return true; }
  );
});

test('fetchRemoteImage: rejects the "localhost" hostname', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://localhost/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects a loopback IPv4 literal (127.0.0.1)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://127.0.0.1/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects an IPv6 loopback literal (::1)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://[::1]/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects a private IPv4 literal (10.x)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://10.0.0.5/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects a private IPv4 literal (192.168.x)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://192.168.1.50/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects a link-local IPv4 literal (169.254.x — cloud metadata range)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://169.254.169.254/latest/meta-data'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: rejects an IPv6 link-local literal (fe80::)', async (t) => {
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://[fe80::1]/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

// ── hostname resolves via (mocked) DNS to a disallowed address ────────────

test('fetchRemoteImage: rejects a hostname that DNS-resolves to a private IPv4 address', async (t) => {
  mockDns(t, ['10.1.2.3']);
  const { fetchRemoteImage } = await loadModule(t);
  await assert.rejects(
    () => fetchRemoteImage('http://internal.example.com/image.png'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

// ── everything below controls the real HTTP response via a mocked fetch ──

test('fetchRemoteImage: a valid HTTPS image is fetched and returned as {mimeType, data}', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  const bytes = new Uint8Array([137, 80, 78, 71]);
  t.mock.method(globalThis, 'fetch', async () => fakeImageResponse({ contentType: 'image/png', contentLength: String(bytes.length), body: bytes }));

  const result = await fetchRemoteImage('https://images.example.com/photo.png');

  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(Array.from(result.data), Array.from(bytes));
});

test('fetchRemoteImage: rejects an unsupported MIME type', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', async () => fakeImageResponse({ contentType: 'application/pdf', body: new Uint8Array([1, 2, 3]) }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/file.pdf'),
    (err: any) => { assert.equal(err.code, 'UNSUPPORTED_MIME_TYPE'); return true; }
  );
});

test('fetchRemoteImage: rejects an image whose Content-Length exceeds the maximum size', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', async () => fakeImageResponse({ contentType: 'image/png', contentLength: String(50 * 1024 * 1024) }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/huge.png'),
    (err: any) => { assert.equal(err.code, 'IMAGE_TOO_LARGE'); return true; }
  );
});

test('fetchRemoteImage: rejects a streamed body that exceeds the size cap even with no/lying Content-Length header', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  const bigChunk = new Uint8Array(1024);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // No content-length header at all; stream well past a tiny custom cap.
      for (let i = 0; i < 20; i++) controller.enqueue(bigChunk);
      controller.close();
    }
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/streamed.png', { maxBytes: 2048 }),
    (err: any) => { assert.equal(err.code, 'IMAGE_TOO_LARGE'); return true; }
  );
});

test('fetchRemoteImage: rejects a non-2xx HTTP response', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', async () => fakeImageResponse({ status: 404, contentType: 'text/html' }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/missing.png'),
    (err: any) => { assert.equal(err.code, 'BAD_STATUS'); return true; }
  );
});

test('fetchRemoteImage: a fetch that never resolves is aborted by the timeout', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', (_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/slow.png', { timeoutMs: 20 }),
    (err: any) => { assert.equal(err.code, 'FETCH_FAILED'); return true; }
  );
});

test('fetchRemoteImage: an externally provided AbortSignal cancels the fetch', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', (_url: string, init: any) => new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    // The internal AbortController may already be aborted by the time this
    // mock runs (it composes the caller's signal synchronously before ever
    // reaching fetch) — an addEventListener alone would then wait forever
    // for an event that already fired.
    if (init.signal.aborted) rejectAbort();
    else init.signal.addEventListener('abort', rejectAbort, { once: true });
  }));

  const controller = new AbortController();
  const promise = fetchRemoteImage('https://images.example.com/slow.png', { signal: controller.signal, timeoutMs: 60_000 });
  controller.abort();

  await assert.rejects(() => promise, (err: any) => { assert.equal(err.code, 'FETCH_FAILED'); return true; });
});

test('fetchRemoteImage: rejects when a redirect points to a private/internal address (unsafe redirect destination)', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === 'https://images.example.com/redirector') {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    throw new Error('should never fetch the redirect target');
  });

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/redirector'),
    (err: any) => { assert.equal(err.code, 'DISALLOWED_HOST'); return true; }
  );
});

test('fetchRemoteImage: follows a safe redirect to its final destination and validates that response', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === 'https://images.example.com/redirector') {
      return new Response(null, { status: 302, headers: { location: 'https://images.example.com/final.png' } });
    }
    return fakeImageResponse({ contentType: 'image/jpeg', body: bytes });
  });

  const result = await fetchRemoteImage('https://images.example.com/redirector');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(Array.from(result.data), Array.from(bytes));
});

test('fetchRemoteImage: rejects after exceeding the maximum redirect count', async (t) => {
  mockDns(t, ['93.184.216.34']);
  const { fetchRemoteImage } = await loadModule(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'https://images.example.com/next' } }));

  await assert.rejects(
    () => fetchRemoteImage('https://images.example.com/start'),
    (err: any) => { assert.equal(err.code, 'TOO_MANY_REDIRECTS'); return true; }
  );
});
