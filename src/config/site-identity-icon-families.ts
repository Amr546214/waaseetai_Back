import { createHash } from 'node:crypto';
import FAMILIES_JSON from './site-identity-icon-families.json';
import { ICON_ID_PATTERN, ICON_PREFIX, iconEntry, iconKeyOf } from './site-identity-icons';

/**
 * Icon FAMILIES (Round 7): a family groups `icon.fn.<symbolId>` keys that are THE SAME ELEMENT drawn in several places (the notifications bell and every copy / adapter of it). A functionally different icon
 * is never a member (it keeps its own key). The definition is the checked-in handwritten `site-identity-icon-families.json`; this module validates it at load time (a bad file throws - nothing is dropped silently)
 * and exposes it to the service. Contract: qa-final-2026-10-14/site-control/IDENTITY-ROUND7-CONTRACT-2026-10-28.md
 */
export const FAMILY_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
export const FAMILY_MIN_MEMBERS = 2;
export const FAMILY_MAX_MEMBERS = 40;
export type FamilyRole = 'primary' | 'copy' | 'adapter';
export interface FamilyMember { symbolId: string; key: string; role: FamilyRole; note: string | null }
export interface IconFamily { id: string; label: string; description: string; members: FamilyMember[] }
interface RawFamilies { families: Array<{ id: string; label: string; description: string; members: Array<{ symbolId: string; role: string; note?: string }> }> }

/** validates a raw definition; exported so the unit test can feed it hostile files */
export function parseFamilies(raw: unknown, isWired: (symbolId: string) => boolean = id => iconEntry(id)?.reason === null): IconFamily[] {
	const fail = (m: string): never => { throw new Error(`site-identity-icon-families.json: ${m}`); };
	const list = (raw as RawFamilies | null)?.families; if (!Array.isArray(list)) return fail('"families" must be an array');
	const ids = new Set<string>(); const owner = new Map<string, string>(); const out: IconFamily[] = [];
	for (const f of list) {
		if (!f || typeof f.id !== 'string' || !FAMILY_ID_PATTERN.test(f.id)) return fail(`bad family id ${JSON.stringify(f?.id)}`);
		if (ids.has(f.id)) return fail(`duplicate family ${f.id}`); ids.add(f.id);
		if (typeof f.label !== 'string' || !f.label.trim() || typeof f.description !== 'string') return fail(`family ${f.id} needs a label and a description`);
		if (!Array.isArray(f.members) || f.members.length < FAMILY_MIN_MEMBERS || f.members.length > FAMILY_MAX_MEMBERS) return fail(`family ${f.id} must have ${FAMILY_MIN_MEMBERS}-${FAMILY_MAX_MEMBERS} members`);
		const members: FamilyMember[] = [];
		for (const m of f.members) {
			if (!m || typeof m.symbolId !== 'string' || !ICON_ID_PATTERN.test(m.symbolId)) return fail(`family ${f.id}: bad symbolId ${JSON.stringify(m?.symbolId)}`);
			if (!['primary', 'copy', 'adapter'].includes(m.role)) return fail(`family ${f.id}: bad role for ${m.symbolId}`);
			if (!iconEntry(m.symbolId)) return fail(`family ${f.id}: ${m.symbolId} is not on the icon allow-list`);
			if (!isWired(m.symbolId)) return fail(`family ${f.id}: ${m.symbolId} is not wired (nothing follows it)`);
			if (owner.has(m.symbolId)) return fail(`${m.symbolId} is in two families (${owner.get(m.symbolId)} and ${f.id})`); owner.set(m.symbolId, f.id);
			members.push({ symbolId: m.symbolId, key: iconKeyOf(m.symbolId), role: m.role as FamilyRole, note: typeof m.note === 'string' && m.note.trim() ? m.note.trim() : null });
		}
		if (members.filter(m => m.role === 'primary').length !== 1) return fail(`family ${f.id} needs exactly one primary member`);
		out.push({ id: f.id, label: f.label.trim(), description: f.description.trim(), members });
	}
	return out;
}

const FAMILIES: readonly IconFamily[] = parseFamilies(FAMILIES_JSON);
const BY_ID = new Map(FAMILIES.map(f => [f.id, f]));
const BY_KEY = new Map(FAMILIES.flatMap(f => f.members.map(m => [m.key, f] as const)));
export const iconFamilies = (): readonly IconFamily[] => FAMILIES;
export const iconFamily = (id: string): IconFamily | null => BY_ID.get(String(id)) ?? null;
export const familyOfKey = (key: string): IconFamily | null => BY_KEY.get(key) ?? null;
export const familiesRevision = (): string => createHash('sha256').update(JSON.stringify(FAMILIES_JSON)).digest('hex').slice(0, 12);
export const isFamilyKey = (key: string): boolean => key.startsWith(ICON_PREFIX) && BY_KEY.has(key);
