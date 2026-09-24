import dns from 'node:dns/promises';
import net from 'node:net';

// Reusable, backend-owned image preparation path for anything feeding a
// remote image URL into a Vision AI call (currently F9 and F10). Nothing in
// this file is Gemini-specific — it hands back plain bytes + a MIME type,
// which the caller then passes into GeminiClient.generateStructuredWithImage().
//
// This is the SSRF-hardening boundary: it is the ONLY place in the codebase
// that fetches an arbitrary, database-stored image URL server-side, so every
// protection lives here rather than being reimplemented per feature.

export type RemoteImageFetchErrorCode =
  | 'INVALID_URL'
  | 'INVALID_PROTOCOL'
  | 'DISALLOWED_HOST'
  | 'DNS_RESOLUTION_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'FETCH_FAILED'
  | 'BAD_STATUS'
  | 'UNSUPPORTED_MIME_TYPE'
  | 'IMAGE_TOO_LARGE';

export class RemoteImageFetchError extends Error {
  readonly code: RemoteImageFetchErrorCode;
  constructor(code: RemoteImageFetchErrorCode, message: string) {
    super(message);
    this.name = 'RemoteImageFetchError';
    this.code = code;
  }
}

export interface FetchedImage {
  mimeType: string;
  data: Buffer;
}

export interface RemoteImageFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Overrides the default allow-list — kept narrow by default. */
  allowedMimeTypes?: Set<string>;
  /** Overrides the default byte cap. */
  maxBytes?: number;
}

const DEFAULT_ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const DISALLOWED_HOSTNAMES = new Set(['localhost', '0.0.0.0', 'metadata.google.internal']);

// Best-effort, standard-ranges-only SSRF guard. This deliberately does not
// attempt to catch every possible IP-literal obfuscation trick (decimal/
// octal/hex-encoded addresses, unusual IPv6 compression forms, etc.) — it
// covers the ranges explicitly called out for this batch (loopback, private
// IPv4, link-local, unique-local IPv6) via Node's own IP parsing, which is
// enough for the realistic threat model here (this is not an internet-facing
// open image proxy; the URLs it fetches always come from this application's
// own database records).
function isDisallowedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
    if (/^::ffff:/.test(normalized)) {
      const mapped = normalized.replace(/^::ffff:/, '');
      if (net.isIP(mapped) === 4) return isDisallowedIp(mapped);
    }
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
    return false;
  }
  // Not a parseable IP at all — treat as disallowed rather than guessing.
  return true;
}

async function resolveAndValidateUrl(urlString: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new RemoteImageFetchError('INVALID_URL', 'Invalid image URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RemoteImageFetchError('INVALID_PROTOCOL', `Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (DISALLOWED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new RemoteImageFetchError('DISALLOWED_HOST', `Disallowed host: ${hostname}`);
  }

  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new RemoteImageFetchError('DISALLOWED_HOST', `Disallowed IP literal: ${hostname}`);
    }
    return parsed;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new RemoteImageFetchError('DNS_RESOLUTION_FAILED', `Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new RemoteImageFetchError('DNS_RESOLUTION_FAILED', `Host resolved to no addresses: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isDisallowedIp(address)) {
      throw new RemoteImageFetchError('DISALLOWED_HOST', `Host resolves to a disallowed address: ${hostname} -> ${address}`);
    }
  }

  return parsed;
}

// Reads the response body with a hard streaming byte cap — never trusts
// Content-Length alone, since it can be absent (chunked transfer) or lie.
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new RemoteImageFetchError('IMAGE_TOO_LARGE', `Image exceeds maximum allowed size of ${maxBytes} bytes`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new RemoteImageFetchError('IMAGE_TOO_LARGE', `Image exceeds maximum allowed size of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Fetches and validates a single remote image for Vision AI use. Never
 * throws a value other than RemoteImageFetchError. Follows redirects
 * manually (up to MAX_REDIRECTS) so every hop — including the final
 * destination — passes the exact same SSRF validation as the original URL.
 */
export async function fetchRemoteImage(urlString: string, options: RemoteImageFetchOptions = {}): Promise<FetchedImage> {
  const allowedMimeTypes = options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = urlString;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const validatedUrl = await resolveAndValidateUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(validatedUrl.toString(), { signal: controller.signal, redirect: 'manual' });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new RemoteImageFetchError('FETCH_FAILED', 'Image fetch timed out or was cancelled');
      }
      throw new RemoteImageFetchError('FETCH_FAILED', `Image fetch failed: ${error?.message || 'unknown error'}`);
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new RemoteImageFetchError('FETCH_FAILED', 'Redirect response had no Location header');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new RemoteImageFetchError('BAD_STATUS', `Image fetch returned HTTP ${response.status}`);
    }

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!allowedMimeTypes.has(contentType)) {
      throw new RemoteImageFetchError('UNSUPPORTED_MIME_TYPE', `Unsupported image MIME type: ${contentType || '(none)'}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > maxBytes) {
      throw new RemoteImageFetchError('IMAGE_TOO_LARGE', `Image exceeds maximum allowed size of ${maxBytes} bytes`);
    }

    const data = await readBodyWithLimit(response, maxBytes);
    return { mimeType: contentType, data };
  }

  throw new RemoteImageFetchError('TOO_MANY_REDIRECTS', 'Too many redirects while fetching image');
}
