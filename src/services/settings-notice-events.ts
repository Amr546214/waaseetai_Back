import type { SettingsNotice } from './settings-bus';

/**
 * The public socket events a settings notice turns into. A notice with NO keys is the bus's "resync" (the listener reconnected, notices may have been missed): every kind of change is
 * announced then, so a browser never stays on a stale taxonomy or a stale identity. Payloads carry a number only (never values, actors or secrets).
 */
export function socketEventsFor(n: Pick<SettingsNotice, 'keys' | 'revision' | 'at'>): { name: 'taxonomy:changed' | 'identity:changed'; payload: { revision?: number; at?: number } }[] {
	const resync = !n.keys.length;
	const out: { name: 'taxonomy:changed' | 'identity:changed'; payload: { revision?: number; at?: number } }[] = [];
	if (resync || n.keys.includes('taxonomy')) out.push({ name: 'taxonomy:changed', payload: { revision: n.revision ?? n.at } });
	if (resync || n.keys.includes('site_identity')) out.push({ name: 'identity:changed', payload: { at: n.at } });
	return out;
}
