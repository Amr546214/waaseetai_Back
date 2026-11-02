/**
 * TOKEN_REGISTRY - the design tokens (CSS custom properties) that the identity manager may override («التحكم بالموقع» > الهوية > الألوان والخطوط).
 *
 * Source of the defaults: the EFFECTIVE computed values of the production build (FE `identity-tokens.effective.golden.json`: styles.css + waseet-design-system.css, default state) - styles.css alone is NOT enough, the design system redefines --teal/--blue/--ai/--ai-bg/--card-shadow/--font-family. Originally read from `src/styles.css` (wt-fe-id @ 66ad2972) `:root` block (= DARK, the default theme) and `.theme-light` block (= LIGHT). Only variables that REALLY are the central layer are listed:
 * 37 declared in `:root` (+ the new `--font-family`); 29 of them are redefined by `.theme-light`; only --grad is NOT redefined in light, so their light default IS the dark default
 * (`sharedWithDark`). Literal colours written directly in components / override blocks are NOT tokens and stay unbound.
 *
 * The strings below are in the CANONICAL form of src/utils/site-identity-tokens.ts (lower-case hex, no spaces after commas, alpha without a leading zero or trailing zeros, `0` lengths with a unit-less shadow zero);
 * the FE guard spec compares them to styles.css after the same normalisation, and a BE test (site-identity-tokens.test.ts) re-reads styles.css when it is reachable.
 */
export type TokenType = 'color' | 'paint' | 'shadow' | 'length' | 'font-family';
export type TokenScope = 'color' | 'layout' | 'typography';

export interface TokenDef {
	name: string; type: TokenType; scope: TokenScope; label: string;
	/** default in the DARK theme (= the `:root` value) */
	dark: string;
	/** default in the LIGHT theme (`.theme-light`); undefined = not redefined there (light default = dark default) */
	light?: string;
	/** length bounds (px / rem) */
	min?: { px: number; rem: number }; max?: { px: number; rem: number };
}

const c = (name: string, label: string, dark: string, light?: string): TokenDef => ({ name, type: 'color', scope: 'color', label, dark, light });
const p = (name: string, label: string, dark: string, light?: string): TokenDef => ({ name, type: 'paint', scope: 'color', label, dark, light });

export const TOKEN_REGISTRY: readonly TokenDef[] = [
	c('--pg', 'خلفية الصفحة', '#070d24', '#eef2fa'),
	c('--pop-bg', 'خلفية القوائم المنبثقة والأدراج', 'rgba(9,18,48,.98)', '#ffffff'),
	p('--surface', 'سطح البطاقات الزجاجية', 'linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.01))', '#fff'),
	c('--border', 'الحدود العامة', 'rgba(255,255,255,.08)', '#e7eaf1'),
	c('--crd-bd', 'حدود البطاقات', 'rgba(255,255,255,.08)', '#e2e8f4'),
	c('--crd-bg', 'خلفية البطاقات', 'rgba(255,255,255,.03)', '#ffffff'),
	c('--tint-bd', 'حدود الخلفيات المظلّلة', 'rgba(255,255,255,.08)', '#e2e8f4'),
	c('--sec-bg', 'خلفية الأقسام', 'rgba(13,27,42,.55)', '#ffffff'),
	c('--sec-bd', 'حدود الأقسام', 'rgba(255,255,255,.07)', '#e2e8f4'),
	c('--sec-bd-hover', 'حدود الأقسام عند المرور', 'rgba(0,210,255,.35)', 'rgba(43,127,255,.35)'),
	c('--sec-bg-hover', 'خلفية الأقسام عند المرور', 'rgba(255,255,255,.07)', '#fafbff'),
	{ name: '--card-shadow', type: 'shadow', scope: 'color', label: 'ظل البطاقات', dark: 'none', light: '0 2px 10px rgba(15,23,42,.08),0 1px 3px rgba(15,23,42,.05)' },
	c('--txt', 'لون النص الأساسي', '#fff', '#0f172a'),
	c('--txt-2', 'لون النص الثانوي', '#a8b2d1', '#475569'),
	c('--txt-3', 'لون النص الخافت', '#6b7699', '#5b6472'),
	c('--teal', 'اللون التيل (العلامة)', '#2bd4c7', '#0f8a7f'),
	c('--teal-txt', 'نص باللون التيل', '#2bd4c7', '#0f8a7f'),
	c('--blue', 'اللون الأزرق (العلامة)', '#2b7fff', '#1d6fe0'),
	c('--blue-txt', 'نص باللون الأزرق', '#5da0ff', '#1d6fe0'),
	c('--green', 'اللون الأخضر (النجاح)', '#0fa99a', '#0a6f64'),
	c('--kahr', 'اللون الكهرماني (التنبيه)', '#d98a0b', '#9a6700'),
	c('--red', 'اللون الأحمر (الخطأ)', '#ff8c69', '#b42318'),
	c('--ai', 'لون الذكاء الاصطناعي', '#7b2fbe', '#6b27a5'),
	c('--ai-txt', 'نص الذكاء الاصطناعي', '#a56be0', '#6b27a5'),
	c('--ai-bg', 'خلفية عناصر الذكاء الاصطناعي', 'rgba(123,47,190,.15)', 'rgba(123,47,190,.1)'),
	c('--ai-border', 'حدود عناصر الذكاء الاصطناعي', 'rgba(123,47,190,.22)', 'rgba(123,47,190,.28)'),
	c('--ai-nte-bd', 'حدود ملاحظة الذكاء الاصطناعي', 'rgba(123,47,190,.22)', 'rgba(123,47,190,.28)'),
	p('--ai-nte-bg', 'خلفية ملاحظة الذكاء الاصطناعي', 'linear-gradient(135deg,rgba(123,47,190,.09),rgba(43,127,255,.06))', 'rgba(123,47,190,.06)'),
	c('--ai-nte-clr', 'نص ملاحظة الذكاء الاصطناعي', '#a8b2d1', '#475569'),
	p('--grad', 'تدرّج العلامة', 'linear-gradient(135deg,#2bd4c7,#2b7fff)'),
	c('--header-bg', 'خلفية الشريط العلوي', 'rgba(7,13,36,.7)', 'rgba(246,248,252,.94)'),
	c('--footer-bd', 'حدود التذييل', 'rgba(255,255,255,.08)', '#e7eaf1'),
	c('--drop-name', 'اسم القائمة المنسدلة', '#fff', '#0f172a'),
	c('--rec-sub', 'نص فرعي في التوصيات', '#a8b2d1', '#5b6472'),
	// round 9: semantic variables of converted pages (FE identity-semantic-tokens.json; defaults = effective computed values)
	c('--pub-txt', 'النص الأساسي في الصفحات العامة وصفحات الدخول', '#fff', '#070d24'),
	c('--pub-txt-2', 'النص الثانوي في الصفحات العامة وصفحات الدخول', '#a8b2d1', '#56607d'),
	c('--pub-txt-3', 'النص الخافت في الصفحات العامة وصفحات الدخول', '#6b7699', '#6b7699'),
	p('--pub-crd-bg', 'خلفية البطاقات في صفحات الدخول والصفحات القانونية', 'linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.01))', '#ffffff'),
	c('--pub-crd-bd', 'حدود البطاقات في الصفحات العامة', 'rgba(255,255,255,.08)', '#e7eaf1'),
	c('--pub-sec-bg', 'خلفية الأقسام والأزرار الثانوية في الصفحات العامة', 'rgba(255,255,255,.05)', '#ffffff'),
	c('--pub-sec-bd', 'حدود الأقسام والأزرار الثانوية في الصفحات العامة', 'rgba(255,255,255,.15)', 'rgba(7,13,36,.14)'),
	c('--pub-tint-bd', 'حدود المقاطع الملوّنة في الصفحات العامة', 'rgba(43,212,199,.15)', 'rgba(43,127,255,.14)'),
	c('--pub-ai-bg', 'خلفية عناصر الذكاء الاصطناعي في صفحات السوق والدفع', 'rgba(123,47,190,.1)', 'rgba(123,47,190,.1)'),
	c('--brand-teal', 'لون العلامة التيل الثابت (تدرّجات وأزرار الصفحات العامة)', '#2bd4c7', '#2bd4c7'),
	c('--brand-blue', 'لون العلامة الأزرق الثابت (تدرّجات وأزرار الصفحات العامة)', '#2b7fff', '#2b7fff'),
	c('--brand-ai', 'لون الذكاء الاصطناعي الثابت في الصفحات العامة', '#7b2fbe', '#7b2fbe'),
	p('--home-crd-bg', 'خلفية بطاقات الصفحة الرئيسية', 'linear-gradient(135deg,rgba(255,255,255,.03),rgba(255,255,255,.01))', '#ffffff'),
	c('--home-ai-nte-bd', 'حدود ملاحظة الذكاء الاصطناعي في الصفحة الرئيسية', 'rgba(123,47,190,.22)', 'rgba(123,47,190,.2)'),
	p('--home-ai-nte-bg', 'خلفية ملاحظة الذكاء الاصطناعي في الصفحة الرئيسية', 'rgba(123,47,190,.07)', 'rgba(123,47,190,.06)'),
	c('--home-ai-nte-clr', 'نص ملاحظة الذكاء الاصطناعي في الصفحة الرئيسية', 'rgba(232,234,240,.72)', '#56607d'),
	c('--soft-bd', 'حدود ناعمة لأقسام اللوحات (الفاتح)', 'rgba(255,255,255,.07)', '#e7eaf1'),
	c('--notif-txt', 'النص الأساسي في صفحات الإشعارات', '#fff', '#0f172a'),
	c('--notif-client-txt-3', 'النص الخافت في إشعارات العميل', '#6b7699', '#64748b'),
	c('--notif-provider-txt-3', 'النص الخافت في إشعارات المزوّد', '#6b7699', '#475569'),
	c('--aw-txt', 'نص لوحة المساعد (لوحة داكنة دائماً)', '#fff', '#ffffff'),
	c('--aw-txt-2', 'النص الثانوي في لوحة المساعد', '#cbd5e1', '#cbd5e1'),
	c('--aw-txt-3', 'النص الخافت في لوحة المساعد', '#94a3b8', '#94a3b8'),
	c('--aw-sec-bd', 'حدود لوحة المساعد', 'rgba(43,212,199,.2)', 'rgba(43,212,199,.2)'),
	{ name: '--container', type: 'length', scope: 'layout', label: 'العرض الأقصى للمحتوى', dark: '1240px', min: { px: 320, rem: 20 }, max: { px: 2400, rem: 150 } },
	{ name: '--radius', type: 'length', scope: 'layout', label: 'استدارة الزوايا', dark: '16px', min: { px: 0, rem: 0 }, max: { px: 64, rem: 4 } },
	{ name: '--radius-sm', type: 'length', scope: 'layout', label: 'استدارة الزوايا الصغيرة', dark: '10px', min: { px: 0, rem: 0 }, max: { px: 64, rem: 4 } },
	{ name: '--font-family', type: 'font-family', scope: 'typography', label: 'الخط العام', dark: "'Tajawal'" },
];

export const TOKEN_KEYS = ['tokens.colors.light', 'tokens.colors.dark', 'tokens.layout', 'tokens.typography'] as const;
export type TokenKey = typeof TOKEN_KEYS[number];
export const isTokenKey = (key: string): key is TokenKey => (TOKEN_KEYS as readonly string[]).includes(key);

const SCOPE_OF_KEY: Record<TokenKey, TokenScope> = { 'tokens.colors.light': 'color', 'tokens.colors.dark': 'color', 'tokens.layout': 'layout', 'tokens.typography': 'typography' };

/** the token definitions a key may hold, in registry order */
export const tokensOfKey = (key: string): readonly TokenDef[] => (isTokenKey(key) ? TOKEN_REGISTRY.filter(t => t.scope === SCOPE_OF_KEY[key]) : []);
/** the default of one token as seen by one key (light key -> light value, falling back to the dark value for the shared ones) */
export const tokenDefault = (key: string, t: TokenDef): string => (key === 'tokens.colors.light' ? t.light ?? t.dark : t.dark);

/** shape for the admin API (items[].tokens) */
export const tokenSpecOut = (key: string) => tokensOfKey(key).map(t => ({
	name: t.name, type: t.type, label: t.label, default: tokenDefault(key, t), sharedWithDark: key === 'tokens.colors.light' && t.scope === 'color' && t.light === undefined,
	...(t.min ? { min: t.min, max: t.max } : {}),
}));

/** counts shown on the page and asserted by tests */
export const TOKEN_COUNTS = {
	/** custom properties the FE `:root` block declares today (--font-family is NEW: the FE adds it only if it routes Tajawal through it) */
	declaredInRoot: TOKEN_REGISTRY.filter(t => t.scope !== 'typography').length,
	colorLike: TOKEN_REGISTRY.filter(t => t.scope === 'color').length,
	redefinedByThemeLight: TOKEN_REGISTRY.filter(t => t.scope === 'color' && t.light !== undefined).length,
	sharedWithDark: TOKEN_REGISTRY.filter(t => t.scope === 'color' && t.light === undefined).length,
	layout: TOKEN_REGISTRY.filter(t => t.scope === 'layout').length,
	typography: TOKEN_REGISTRY.filter(t => t.scope === 'typography').length,
} as const;
