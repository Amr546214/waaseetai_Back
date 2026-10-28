import { createHash } from 'node:crypto';
import ALLOWLIST_JSON from './site-identity-icon-allowlist.generated.json';

/**
 * The dynamic key family `icon.fn.<symbolId>`: one identity key per function-icon `<symbol id>` of the FE. The ids come ONLY from the checked-in generated allow-list
 * (scripts/site-identity-icon-allowlist.cjs reads the real FE; the guard test site-identity-icons.test.ts compares the two). This file has no dependency on the registry (the registry builds the SiteIdentityKeyDef).
 * Contract: qa-final-2026-10-14/site-control/IDENTITY-ICONS-CONTRACT-2026-10-28.md
 */
export const ICON_PREFIX = 'icon.fn.';
/** at most this many icons may be customised (active) at the same time: bounds the public manifest and what a browser fetches */
export const MAX_CUSTOM_ICONS = 50;
/** at most this many STAGED drafts across the whole family (on top of the per-key limit) */
export const MAX_ICON_DRAFTS_TOTAL = 60;
export const ICON_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ICON_ROOT_ASPECT = { min: 0.5, max: 2 } as const;

export type IconReasonCode = 'NO_CONSUMER' | 'LIBRARY_ONLY' | 'MANAGED_BY_ICON_AI' | 'BAD_ID_CHARS';
export interface IconSymbolEntry { id: string; viewBox: string | null; width: number | null; height: number | null; defs: number; variants: number; reason: 'NO_CONSUMER' | null; sha256: string; byteSize: number; files: string[]; label?: string }
export interface IconExcludedEntry { id: string; reason: IconReasonCode }
export interface IconLibraryOnlyEntry { id: string; library: string; label: string; reason: IconReasonCode }
interface Allowlist { counts: Record<string, number>; symbols: IconSymbolEntry[]; excluded: IconExcludedEntry[]; libraryOnly: IconLibraryOnlyEntry[]; dynamicSymbolDefinitionFiles: string[] }

const DATA = ALLOWLIST_JSON as unknown as Allowlist;
const SYMBOLS: ReadonlyMap<string, IconSymbolEntry> = new Map(DATA.symbols.filter(s => ICON_ID_PATTERN.test(s.id)).map(s => [s.id, s]));
const EXCLUDED: ReadonlyMap<string, IconExcludedEntry> = new Map(DATA.excluded.map(e => [e.id, e]));
const LIBRARY_ONLY: ReadonlyMap<string, IconLibraryOnlyEntry> = new Map(DATA.libraryOnly.map(e => [e.id, e]));

export const ICON_REASON_TEXT: Record<IconReasonCode, string> = {
	NO_CONSUMER: 'الرمز معرّف في الواجهة لكن لا يوجد أي مكان يستخدمه (<use>) أو يشير إليه، فلا شيء يتبع تغييره.',
	LIBRARY_ONLY: 'موجودة في مكتبة الأيقونات فقط (للتجربة): لا يرسمها أي مكوّن في الموقع، فلا شيء يتبع تغييرها.',
	MANAGED_BY_ICON_AI: 'أيقونة الذكاء الاصطناعي الرسمية تُدار من عنصر «أيقونة الذكاء الاصطناعي» (icon.ai) وليس من هنا.',
	BAD_ID_CHARS: 'معرّف الرمز يحتوي أحرفًا غير مسموحة في مفاتيح الهوية.',
};

export const allowlistRevision = (): string => createHash('sha256').update(JSON.stringify(DATA)).digest('hex').slice(0, 12);
export const iconKeyOf = (symbolId: string): string => `${ICON_PREFIX}${symbolId}`;
/** the symbol id of a family key, or null when the key is not of the form icon.fn.<valid id> */
export const symbolIdOf = (key: string): string | null => (typeof key === 'string' && key.startsWith(ICON_PREFIX) && ICON_ID_PATTERN.test(key.slice(ICON_PREFIX.length)) ? key.slice(ICON_PREFIX.length) : null);
export const isIconFamilyKey = (key: string): boolean => typeof key === 'string' && key.startsWith(ICON_PREFIX);
export const iconEntry = (symbolId: string): IconSymbolEntry | null => SYMBOLS.get(symbolId) ?? null;
/** the entry behind a KEY (null = not a key of the family / not on the allow-list) */
export const iconEntryOfKey = (key: string): IconSymbolEntry | null => { const id = symbolIdOf(key); return id ? iconEntry(id) : null; };
/** wired = on the allow-list and something follows it */
export const isIconWired = (key: string): boolean => { const e = iconEntryOfKey(key); return !!e && e.reason === null; };
export const iconSymbols = (): readonly IconSymbolEntry[] => DATA.symbols;
export const iconExcluded = (): readonly IconExcludedEntry[] => DATA.excluded;
export const iconLibraryOnly = (): readonly IconLibraryOnlyEntry[] => DATA.libraryOnly;
export const iconExcludedReason = (symbolId: string): IconReasonCode | null => EXCLUDED.get(symbolId)?.reason ?? LIBRARY_ONLY.get(symbolId)?.reason ?? null;
export const iconCounts = () => ({ symbols: DATA.symbols.length, wired: DATA.symbols.filter(s => !s.reason).length, notWired: DATA.symbols.filter(s => s.reason).length + DATA.libraryOnly.length + DATA.excluded.length, libraryOnly: DATA.libraryOnly.length, excluded: DATA.excluded.length });
