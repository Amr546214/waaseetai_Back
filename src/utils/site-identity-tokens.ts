import { AppError } from './app-error';
import { IDENTITY_FILE_REJECTED, ValidatedUpload, sha256Of } from './site-identity-upload';
import { TOKEN_REGISTRY, TokenDef, TokenKey, TokenType, isTokenKey, tokenDefault, tokensOfKey } from '../config/site-identity-tokens';

/**
 * Validation + canonicalisation of a design-token override set (stored value of a `tokens.*` identity key) and the CSS built from the active sets.
 *
 * WHITELIST, never "cleaning": a value is parsed by a small grammar per token type and REBUILT from the parsed numbers/names; anything the grammar does not know is rejected. Therefore no stored value can ever
 * contain `url(`, `expression(`, `var(`, `calc(`, `@`, `;`, braces, comments, `\`, `<`, `>`, `!important` or a newline, and the generated CSS is safe to embed in a <style> element.
 */
export const TOKEN_MAX_BYTES = 8 * 1024;
export const TOKEN_MAX_VALUE_LENGTH = 200;
export const TOKEN_JSON_MIME = 'application/json';

export class TokenRejected extends AppError {
	constructor(message: string, public readonly reason: string, public readonly tokenName?: string, status = 400) {
		super(message, status, [{ field: 'value', message, reason, ...(tokenName ? { name: tokenName } : {}) }], IDENTITY_FILE_REJECTED);
	}
}

const reject = (reason: string, message: string, name?: string, status = 400): never => { throw new TokenRejected(message, reason, name, status); };

// ---------------------------------------------------------------------------------------------------- value grammars
const FORBIDDEN = /[;{}<>\\@!/\u0000-\u001f\u007f]|\b(?:url|expression|var|calc|attr|env|image-set|element|paint|src|min|max|clamp)\s*\(|(?:^|[^a-z])import(?:$|[^a-z])/i;

/** alpha: 0..1, at most 3 decimals, written without a leading zero and without trailing zeros (.1, .05, 1, 0) */
function alphaOut(raw: string, name: string): string {
	if (!/^(?:\d(?:\.\d{1,3})?|\.\d{1,3})$/.test(raw)) return reject('BAD_VALUE', 'قيمة الشفافية يجب أن تكون بين 0 و1 (حتى 3 منازل).', name);
	const n = Number(raw);
	if (!(n >= 0 && n <= 1)) return reject('OUT_OF_RANGE', 'قيمة الشفافية يجب أن تكون بين 0 و1.', name);
	return String(n).replace(/^0\./, '.');
}
const int = (s: string, lo: number, hi: number, name: string): number => { const n = Number(s); if (!Number.isInteger(n) || n < lo || n > hi) reject('OUT_OF_RANGE', `القيمة ${s} خارج المدى ${lo}–${hi}.`, name); return n; };

export function canonColor(raw: string, name: string): string {
	const v = raw.trim();
	let m: RegExpMatchArray | null;
	if ((m = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/))) return `#${m[1].toLowerCase()}`;
	if (v.toLowerCase() === 'transparent') return 'transparent';
	if ((m = v.match(/^rgba?\( *(\d{1,3}) *, *(\d{1,3}) *, *(\d{1,3}) *(?:, *(\d*\.?\d+) *)?\)$/i))) {
		const [r, g, b] = [int(m[1], 0, 255, name), int(m[2], 0, 255, name), int(m[3], 0, 255, name)];
		return m[4] === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alphaOut(m[4], name)})`;
	}
	if ((m = v.match(/^hsla?\( *(\d{1,3}) *, *(\d{1,3})% *, *(\d{1,3})% *(?:, *(\d*\.?\d+) *)?\)$/i))) {
		const [h, s, l] = [int(m[1], 0, 360, name), int(m[2], 0, 100, name), int(m[3], 0, 100, name)];
		return m[4] === undefined ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${alphaOut(m[4], name)})`;
	}
	return reject('BAD_VALUE', 'لون غير صالح: المسموح #rgb / #rrggbb / #rrggbbaa أو rgb() أو rgba() أو hsl() أو hsla() أو transparent.', name);
}

/** split on commas that are not inside parentheses */
function splitTop(s: string): string[] {
	const out: string[] = []; let depth = 0; let cur = '';
	for (const ch of s) {
		if (ch === '(') depth++; else if (ch === ')') depth--;
		if (depth < 0) return [];
		if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
	}
	if (depth !== 0) return [];
	out.push(cur);
	return out;
}

export function canonPaint(raw: string, name: string): string {
	const v = raw.trim();
	const g = v.match(/^linear-gradient\( *(\d{1,3})deg *,(.+)\)$/i);
	if (!g) return canonColor(v, name);
	const angle = int(g[1], 0, 360, name);
	const parts = splitTop(g[2]);
	if (parts.length < 2 || parts.length > 5) return reject('BAD_VALUE', 'التدرّج يقبل من 2 إلى 5 ألوان.', name);
	const stops = parts.map(part => {
		const m = part.trim().match(/^(.+?)(?: +(\d{1,3})%)?$/);
		if (!m) return reject('BAD_VALUE', 'نقطة تدرّج غير صالحة.', name);
		const col = canonColor(m![1], name);
		return m![2] === undefined ? col : `${col} ${int(m![2], 0, 100, name)}%`;
	});
	return `linear-gradient(${angle}deg,${stops.join(',')})`;
}

export function canonShadow(raw: string, name: string): string {
	const v = raw.trim();
	if (v.toLowerCase() === 'none') return 'none';
	const layers = splitTop(v);
	if (!layers.length || layers.length > 3) return reject('BAD_VALUE', 'الظل يقبل من 1 إلى 3 طبقات أو none.', name);
	return layers.map(layer => {
		const m = layer.trim().match(/^(.*?) *(#[0-9a-fA-F]+|(?:rgba?|hsla?)\([^()]*\)|transparent)$/i);
		if (!m) return reject('BAD_VALUE', 'طبقة ظل غير صالحة: المطلوب x y blur [spread] color.', name);
		const lens = m![1].trim().split(/ +/).filter(Boolean);
		if (lens.length < 3 || lens.length > 4) return reject('BAD_VALUE', 'طبقة الظل تحتاج 3 أو 4 قيم طول ثم اللون.', name);
		const outLens = lens.map((l, i) => {
			const mm = l.match(/^(-?)(\d{1,3}(?:\.\d{1,2})?)(px)?$/);
			if (!mm || (Number(mm[2]) !== 0 && !mm[3])) return reject('BAD_VALUE', 'قيمة طول الظل يجب أن تكون 0 أو عددًا مع px.', name);
			const n = Number(mm![2]);
			if (n > 200 || (i === 2 && mm![1] === '-')) return reject('OUT_OF_RANGE', 'قيمة طول الظل خارج المدى المسموح (حتى 200px، والتمويه غير سالب).', name);
			return n === 0 ? '0' : `${mm![1]}${mm![2]}px`;
		});
		return `${outLens.join(' ')} ${canonColor(m![2], name)}`;
	}).join(',');
}

export function canonLength(raw: string, name: string, def: TokenDef): string {
	const m = raw.trim().match(/^(\d{1,4}(?:\.\d{1,3})?)(px|rem)$/);
	if (!m) return reject('BAD_VALUE', 'قيمة الطول يجب أن تكون عددًا مع px أو rem.', name);
	const n = Number(m[1]); const unit = m[2] as 'px' | 'rem';
	if (def.min && def.max && (n < def.min[unit] || n > def.max[unit])) return reject('OUT_OF_RANGE', `القيمة خارج المدى المسموح لهذا العنصر (${def.min.px}–${def.max.px}px أو ${def.min.rem}–${def.max.rem}rem).`, name);
	return `${n}${unit}`;
}

const GENERIC_FAMILIES = ['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace'];
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default'];
export function canonFontFamily(raw: string, name: string): string {
	const parts = raw.split(',').map(s => s.trim());
	if (parts.length < 1 || parts.length > 6 || parts.some(s => !s)) return reject('BAD_VALUE', 'قائمة الخطوط تقبل من 1 إلى 6 أسماء مفصولة بفاصلة.', name);
	const out = parts.map(entry => {
		const q = entry.match(/^'([^']+)'$/) ?? entry.match(/^"([^"]+)"$/);
		const nm = (q ? q[1] : entry).replace(/ {2,}/g, ' ').trim();
		const low = nm.toLowerCase();
		if (!q && GENERIC_FAMILIES.includes(low)) return low;
		if (CSS_WIDE.includes(low) || GENERIC_FAMILIES.includes(low)) return reject('BAD_VALUE', 'اسم خط غير مسموح.', name);
		if (!/^[\p{L}][\p{L}\p{N} _-]{0,39}$/u.test(nm)) return reject('BAD_VALUE', 'اسم الخط يقبل حروفًا وأرقامًا ومسافة وشرطة فقط (حتى 40 حرفًا).', name);
		return `'${nm}'`;
	});
	// no generic fallback is demanded: the site's --font-body/--font-heading/--font-numeric append `, system-ui, sans-serif` themselves
	return out.join(',');
}

export function canonValue(def: TokenDef, raw: string): string {
	const t: TokenType = def.type;
	if (t === 'color') return canonColor(raw, def.name);
	if (t === 'paint') return canonPaint(raw, def.name);
	if (t === 'shadow') return canonShadow(raw, def.name);
	if (t === 'length') return canonLength(raw, def.name, def);
	return canonFontFamily(raw, def.name);
}

// ---------------------------------------------------------------------------------------------------- the set
export interface ValidatedTokens { value: Record<string, string>; canonicalJson: string; dropped: string[]; changed: boolean }

/** validates a parsed value for one key; the result is sparse, in registry order, canonical and without entries equal to the default */
export function validateTokenValue(key: string, input: unknown, opts: { allowEmpty?: boolean } = {}): ValidatedTokens {
	if (!isTokenKey(key)) return reject('UNKNOWN_TOKEN', 'مفتاح الرموز غير معروف.');
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject('NOT_OBJECT', 'القيمة يجب أن تكون كائنًا من أزواج {"--اسم":"قيمة"}.');
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length > TOKEN_REGISTRY.length) return reject('TOO_MANY_ENTRIES', 'عدد العناصر أكبر من عدد الرموز المعرّفة.');
	const defs = new Map(tokensOfKey(key).map(d => [d.name, d]));
	const out = new Map<string, string>(); const dropped: string[] = []; let changed = false;
	for (const [name, raw] of entries) {
		if (!/^--[a-z0-9-]{1,40}$/.test(name)) return reject('BAD_NAME', 'اسم الرمز غير صالح (يجب أن يكون --اسم بحروف صغيرة وأرقام وشرطات).', name.slice(0, 60));
		const def = defs.get(name);
		if (!def) return reject('UNKNOWN_TOKEN', 'هذا الرمز غير معرّف لهذا العنصر.', name);
		if (typeof raw !== 'string') return reject('NOT_STRING', 'قيمة الرمز يجب أن تكون نصًا.', name);
		if (raw.length > TOKEN_MAX_VALUE_LENGTH) return reject('VALUE_TOO_LONG', `قيمة الرمز أطول من ${TOKEN_MAX_VALUE_LENGTH} حرفًا.`, name);
		if (FORBIDDEN.test(raw)) return reject('FORBIDDEN_SYNTAX', 'القيمة تحتوي صياغة غير مسموحة (url أو var أو ; أو أقواس معقوفة أو @ أو تعليقات ...).', name);
		const canon = canonValue(def, raw);
		if (canon !== raw) changed = true;
		if (canon === tokenDefault(key, def)) { dropped.push(name); changed = true; continue; }
		out.set(name, canon);
	}
	if (!out.size && !opts.allowEmpty) return reject('EMPTY_OVERRIDES', 'لا توجد قيم مختلفة عن الافتراضي. للعودة إلى الافتراضي استخدم «استعادة الافتراضي».');
	const value: Record<string, string> = {};
	for (const d of defs.values()) if (out.has(d.name)) value[d.name] = out.get(d.name)!;
	return { value, canonicalJson: JSON.stringify(value), dropped, changed };
}

/** validates uploaded BYTES (a JSON object) - the path used by the upload pipeline and by the public manifest when it re-reads stored rows */
export function validateTokenBytes(key: string, bytes: Uint8Array, opts: { allowEmpty?: boolean } = {}): ValidatedTokens {
	if (bytes.length > TOKEN_MAX_BYTES) return reject('TOO_BIG', `ملف الرموز أكبر من الحد الأقصى (${TOKEN_MAX_BYTES / 1024}KB).`, undefined, 413);
	let text: string;
	try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return reject('NOT_UTF8', 'الملف ليس نصًا بترميز UTF-8.'); }
	if (text.charCodeAt(0) === 0xfeff) return reject('NOT_JSON', 'الملف يبدأ بعلامة BOM؛ احفظه JSON عاديًا بترميز UTF-8.');
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return reject('NOT_JSON', 'الملف ليس JSON صالحًا.'); }
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		const names = text.match(/"[^"\\]*"\s*:/g) ?? [];
		if (names.length !== Object.keys(parsed as object).length) return reject('BAD_NAME', 'يوجد اسم رمز مكرر أو بنية غير مسطّحة.');
	}
	return validateTokenValue(key, parsed, opts);
}

/** upload branch used by validateIdentityUpload for kind 'json' */
export function validateTokenUpload(key: string, buf: Buffer): ValidatedUpload {
	const v = validateTokenBytes(key, buf);
	const bytes = Buffer.from(v.canonicalJson, 'utf8');
	return {
		mime: TOKEN_JSON_MIME, bytes, sha256: sha256Of(bytes), byteSize: bytes.length, width: null, height: null,
		note: v.dropped.length ? `أُسقطت ${v.dropped.length} قيمة مطابقة للافتراضي: ${v.dropped.join(' ')}`.slice(0, 280) : null,
		sanitized: { changed: v.changed, removed: v.dropped.length },
	};
}

// ---------------------------------------------------------------------------------------------------- CSS
export type TokenSets = Partial<Record<TokenKey, Record<string, string>>>;
/** (0,2,x) specificity on every element that may carry the light class (html, body, any): beats the html.theme-light / body.theme-light base rules and the dark :root rule */
export const LIGHT_SELECTOR = 'html.theme-light.theme-light,html.light-theme.light-theme,body.theme-light.theme-light,body.light-theme.light-theme,.theme-light.theme-light,.light-theme.light-theme';
const decl = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');

/**
 * The ready-to-inject CSS for the ACTIVE override sets ('' when there is nothing to inject). Values must already be validated (they are re-checked here: anything unsafe aborts with '' for that block).
 *   :root{layout + typography}
 *   :root:not(.theme-light):not(.light-theme){dark overrides}
 *   LIGHT_SELECTOR{light overrides + pins of the shared names (today only --grad) a dark override would otherwise leak into light}
 */
export function buildTokensCss(sets: TokenSets): string {
	const safe = (key: TokenKey): Record<string, string> => {
		const s = sets[key]; if (!s) return {};
		try { return validateTokenValue(key, s, { allowEmpty: true }).value; } catch { return {}; }
	};
	const layout = { ...safe('tokens.layout'), ...safe('tokens.typography') };
	const dark = safe('tokens.colors.dark'); const light = { ...safe('tokens.colors.light') };
	const darkDefs = new Map(tokensOfKey('tokens.colors.dark').map(d => [d.name, d]));
	for (const name of Object.keys(dark)) { const d = darkDefs.get(name)!; if (d.light === undefined && !(name in light)) light[name] = d.dark; }
	// keep registry order for the light block
	const order = new Map(TOKEN_REGISTRY.map((d, i) => [d.name, i]));
	const lightSorted = Object.fromEntries(Object.entries(light).sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0)));
	const rules = [
		Object.keys(layout).length ? `:root{${decl(layout)}}` : '',
		Object.keys(dark).length ? `:root:not(.theme-light):not(.light-theme){${decl(dark)}}` : '',
		Object.keys(lightSorted).length ? `${LIGHT_SELECTOR}{${decl(lightSorted)}}` : '',
	].filter(Boolean);
	return rules.join('\n');
}
