import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { prisma } from '../config/db';
import { logger } from '../config/logger';

/**
 * Cross-instance change notice for platform settings. One shared mechanism that needs no new infrastructure: PostgreSQL LISTEN/NOTIFY on the database every backend instance already uses.
 * The notice carries ONLY the changed keys (never values, never secrets); every instance drops its cache and re-reads the stored state, so a missed notice is harmless
 * (the cache TTL and the clients' resync on reconnect/visibility still converge). Published only after the saving transaction has committed.
 */
export const SETTINGS_CHANNEL = 'waseet_settings';
export const INSTANCE_ID = randomUUID();
export interface SettingsNotice { keys: string[]; at: number; origin: string }
type Handler = (n: SettingsNotice) => void | Promise<void>;
const handlers = new Set<Handler>();
export const onSettingsNotice = (h: Handler) => { handlers.add(h); return () => handlers.delete(h); };
const dispatch = async (n: SettingsNotice) => { for (const h of handlers) { try { await h(n); } catch (e) { logger.error(`[SettingsBus] handler failed: ${(e as Error)?.message}`); } } };

/** after commit: tell this process directly (never depends on the listener) and every other instance through the database */
export async function publishSettingsChange(keys: string[]): Promise<void> {
	const n: SettingsNotice = { keys: [...keys].slice(0, 100), at: Date.now(), origin: INSTANCE_ID };
	void dispatch(n);
	try { await prisma.$queryRaw`SELECT pg_notify(${SETTINGS_CHANNEL}, ${JSON.stringify(n)})`; }
	catch (e) { logger.error(`[SettingsBus] notify failed (other instances converge via cache TTL): ${(e as Error)?.message}`); }
}

let client: Client | null = null; let stopped = false; let retry = 0;
/** one dedicated connection per process; reconnects with backoff and, after a reconnect, tells the handlers to resync because notices may have been missed */
export function startSettingsListener(): void {
	if (!process.env.DATABASE_URL) return;
	stopped = false;
	const connect = async () => {
		if (stopped) return;
		const c = new Client({ connectionString: process.env.DATABASE_URL });
		const again = () => { if (client === c) client = null; c.removeAllListeners(); void c.end().catch(() => undefined); if (stopped) return; retry = Math.min(retry + 1, 6); setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry)); };
		c.on('error', e => { logger.warn(`[SettingsBus] listener error: ${e.message}`); again(); });
		c.on('end', again);
		c.on('notification', m => {
			if (m.channel !== SETTINGS_CHANNEL || !m.payload) return;
			try { const n = JSON.parse(m.payload) as SettingsNotice; if (n.origin !== INSTANCE_ID) void dispatch(n); } catch { /* ignore malformed */ }
		});
		try { await c.connect(); await c.query(`LISTEN ${SETTINGS_CHANNEL}`); client = c; const wasRetry = retry > 0; retry = 0; if (wasRetry) void dispatch({ keys: [], at: Date.now(), origin: 'resync' }); }
		catch (e) { logger.warn(`[SettingsBus] cannot listen: ${(e as Error).message}`); again(); }
	};
	void connect();
}
export function stopSettingsListener(): void { stopped = true; const c = client; client = null; if (c) { c.removeAllListeners(); void c.end().catch(() => undefined); } }
