import { systemSettingsService } from '../services/system-settings.service';

/**
 * Time and the platform time zone (setting `defaultTimezone`). Stored instants stay UTC (Date / timestamptz): the zone only decides how a "day" or a "month" is cut for reports and how a time
 * is WRITTEN for people (CSV, e-mail). `null` = the setting is "browser" (nothing configured): callers keep their existing behaviour untouched.
 */
export async function platformZone(): Promise<string | null> {
	const z = await systemSettingsService.get<string>('defaultTimezone');
	return z && z !== 'browser' ? z : null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const dtf = (zone: string) => { let f = fmtCache.get(zone); if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmtCache.set(zone, f); } return f; };

/** the wall-clock parts of an instant in a zone */
export function zonedParts(date: Date, zone: string) {
	const p = Object.fromEntries(dtf(zone).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)])) as Record<string, number>;
	return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}
/** offset of a zone at an instant, in ms (zone wall clock minus UTC) */
export function zoneOffsetMs(date: Date, zone: string): number {
	const p = zonedParts(date, zone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
/** the UTC instant at which the given wall-clock time (in the zone) happens */
export function instantOfWallClock(zone: string, y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Date {
	const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
	const first = guess - zoneOffsetMs(new Date(guess), zone);
	return new Date(guess - zoneOffsetMs(new Date(first), zone)); // second pass settles a DST edge
}
export const startOfMonthInZone = (zone: string, now = new Date()) => { const p = zonedParts(now, zone); return instantOfWallClock(zone, p.year, p.month, 1); };
export const startOfDayInZone = (zone: string, now = new Date()) => { const p = zonedParts(now, zone); return instantOfWallClock(zone, p.year, p.month, p.day); };
export const startOfPreviousMonthInZone = (zone: string, now = new Date()) => startOfMonthInZone(zone, new Date(startOfMonthInZone(zone, now).getTime() - 1));
const two = (n: number) => String(n).padStart(2, '0');
/** "2026-10-25 21:30" written in the zone (for CSV / e-mail), never an ambiguous server-local string */
export function formatInZone(date: Date, zone: string, withTime = true): string {
	const p = zonedParts(date, zone); const d = `${p.year}-${two(p.month)}-${two(p.day)}`;
	return withTime ? `${d} ${two(p.hour)}:${two(p.minute)}` : d;
}
