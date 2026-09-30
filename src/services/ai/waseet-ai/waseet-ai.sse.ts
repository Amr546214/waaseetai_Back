// Minimal, dependency-free Server-Sent Events parser for WaseetAI streaming
// endpoints (/v1/ai/project-description/stream, /v1/ai/help/chat, ...).
//
// The integration guide documents events by name (generation.started,
// text.delta, citations, generation.completed) and shows consumers reading
// `data: ` lines. It does NOT pin down whether the name arrives in a standard
// `event:` field or inside the JSON payload, so this parser accepts both:
//   event: text.delta\ndata: {"chunk":"..."}\n\n
//   data: {"event":"text.delta","chunk":"..."}\n\n   (also "type")
// Any mismatch with the live service must be confirmed once the bearer token
// is configured (see the Part J checkpoint in DRIVE_REVIEW_PLAN.md).

export interface WaseetAiSseEvent {
  /** Event name, e.g. 'text.delta'. 'message' when the stream gave none. */
  event: string;
  /** Parsed JSON payload, or the raw string if it was not valid JSON. */
  data: unknown;
}

function parseBlock(block: string): WaseetAiSseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue; // blank or comment/heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  if (rawData === '[DONE]') return { event: eventName ?? 'done', data: null };

  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // leave as raw string
  }

  if (!eventName && data && typeof data === 'object' && !Array.isArray(data)) {
    const named = (data as Record<string, unknown>).event ?? (data as Record<string, unknown>).type;
    if (typeof named === 'string') eventName = named;
  }

  return { event: eventName ?? 'message', data };
}

/**
 * Reads a byte stream (fetch Response.body) and yields parsed SSE events.
 * Handles events split across network chunks and multi-byte UTF-8 (Arabic)
 * characters split across chunk boundaries.
 */
export async function* parseSseStream(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<WaseetAiSseEvent, void, void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const iterable: AsyncIterable<Uint8Array> =
    Symbol.asyncIterator in (body as object) ? (body as AsyncIterable<Uint8Array>) : readableToIterable(body as ReadableStream<Uint8Array>);

  for await (const chunk of iterable) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseBlock(block);
      if (evt) yield evt;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const evt = parseBlock(buffer);
    if (evt) yield evt;
  }
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
