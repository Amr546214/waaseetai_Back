/**
 * Runs `fn` after every earlier call with the same key has finished (one process: the backend runs as a single instance, like the OTP throttle).
 * Used so that two simultaneous requests for the same account (double click, two tabs) cannot both create / delete the same one-time code.
 */
const tails = new Map<string, Promise<void>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
