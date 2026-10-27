/**
 * THE registry of the platform's managed visual identity («التحكم بالموقع» > الهوية). Source of truth for: which keys exist, what each one is today (the built-in default = the identity published
 * today, NEVER changed by founding this system), what a replacement must satisfy, and who really consumes it.
 *
 * Built from the REAL inventory of the FE (sc-fe-team @ ac0ae9a0) and this BE, 2026-10-27: see qa-final-2026-10-14/site-control/IDENTITY-INVENTORY-2026-10-27.md (key -> default -> consumers -> file:line,
 * with the sha256 of every default). `defaultFingerprint` is the REAL mime / dimensions / size / sha256 of the default file (for the inline symbol: of the markup in core/constants/ai-icon.ts);
 * scripts/site-identity-fingerprints.cjs recomputes them from the FE repo (`--check`), and the FE keeps a spec that compares its own defaults map to this file.
 *
 * `wired` is NOT data of a key and NOT editable through any API: it is membership in WIRED_KEYS below, a single list the coordinator edits when an FE (or BE) consumer really reads the key through the
 * identity service. A key that is not wired is returned with `wired:false` and its reason and refuses uploads / publishes / restores.
 *
 * The platform NAME is not an identity key: it stays the existing `platformName` setting.
 *
 * NOT identity (they only look similar, they have other owners; never put them here):
 *  - functional / sprite icons (#i-*, #ws-*, #ic-*: bell, eye, bolt, alert, wallet ... ) including the look-alike AI library (#ws-trust-ai, #ws-ai-*, .ai-persona-icon) - only `#i-ai` is the AI identity mark;
 *  - third-party trademarks (#ic-social-*, payment / bank / country-flag assets under public/assets/flags and payment-method logos);
 *  - everything a user uploads (avatars, portfolio, KYC documents, service images, marketing assets managed by admin-marketing-assets);
 *  - content / marketing imagery (public/assets/images/*: service-*.png, dashboard-mockup, contract-*, message*, image*, avatar-1, traingl) and the unreferenced robot illustrations among them;
 *  - the design-system documentation under public/tools/** (reference material, not served as the site's identity);
 *  - watermarks / "logo-xs..xl" sizes (derived at render time from the logo by CSS, no separate asset); literal colours / fonts written inside components (only the central CSS variables are token keys: group `token`, see site-identity-tokens.ts).
 */

import { createHash } from 'node:crypto';

export const IDENTITY_GROUPS = ['logo', 'favicon', 'icon', 'character', 'token'] as const;
export type IdentityGroup = typeof IDENTITY_GROUPS[number];
export type IdentityKind = 'raster' | 'svg' | 'ico' | 'json';

/** current limits of the design (decision 3): raster / ico <= 512 KB, svg <= 64 KB */
export const RASTER_MAX_BYTES = 512 * 1024;
export const SVG_MAX_BYTES = 64 * 1024;
/** the sprite atlases of the characters are 0.9 - 1.6 MB TODAY: a replacement cannot be smaller than the sheet it replaces, so these keys (and only these) carry an explicit larger cap */
export const ATLAS_MAX_BYTES = 2 * 1024 * 1024;
/** hard ceilings for any raster / ico whatever the key says (decompression-bomb guard) */
export const ABSOLUTE_MAX_SIDE = 8192;
export const ABSOLUTE_MAX_PIXELS = 16_000_000;

export interface DimensionRule {
	minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number;
	/** width / height; svg is measured from its viewBox */
	aspectMin?: number; aspectMax?: number;
	/** the replacement must be exactly this size (sprite atlases whose frame geometry is hard-coded by the consumer) */
	exact?: { width: number; height: number };
}

export type DefaultAsset =
	| { type: 'file'; /** path under the FE `public/` folder as the browser requests it */ path: string }
	| { type: 'inline-symbol'; symbolId: string; /** where the markup lives */ source: string }
	/** design tokens: the default is "no override" (the value `{}`), the real defaults live in TOKEN_REGISTRY (site-identity-tokens.ts) */
	| { type: 'tokens'; source: string };

export interface DefaultFingerprint { mime: string; width: number | null; height: number | null; byteSize: number; sha256: string; /** ico: how many images the file holds */ entries?: number; note?: string }

export interface IdentityUsage { where: string; ref: string }

export interface SiteIdentityKeyDef {
	key: string;
	group: IdentityGroup;
	label: string;
	description: string;
	kind: IdentityKind;
	allowedMimes: readonly string[];
	/** applies to raster / ico; an svg is always capped at SVG_MAX_BYTES (or this value when smaller) */
	maxBytes: number;
	dimensions: DimensionRule;
	defaultAsset: DefaultAsset;
	defaultFingerprint: DefaultFingerprint;
	usages: readonly IdentityUsage[];
	/** shown while the key is not wired */
	notWiredReason: string;
	/** extra facts the FE worker needs (differences between inline copies, etc.) */
	notes?: readonly string[];
}

const MARK_FP: DefaultFingerprint = { mime: 'image/png', width: 614, height: 371, byteSize: 14651, sha256: 'e4cb6ce7a96c05632e1b75e1d3b0f20ebdae27a1c8d5d9ff633922b118443c1b' };
const MARK_DIMS: DimensionRule = { minWidth: 64, minHeight: 32, maxWidth: 2048, maxHeight: 2048, aspectMin: 1, aspectMax: 3 };
const NOT_READ = 'لا يقرأ أي مكوّن في الواجهة هذا المفتاح عبر خدمة الهوية بعد؛ يُفعَّل عند ربط مستهلكيه الفعليين (القيمة الافتراضية هي ما يُعرض اليوم).';
const ROBOT_JS = 'public/bebo/robot.js';
const ATLAS_REASON = 'تبني robot.js عناوين صور الشخصية بنفسها نسبةً إلى موقع السكربت (new URL) وإحداثيات الإطارات ثابتة داخلها؛ لا يوجد قارئ للهوية، واستبدال اللوحة يتطلب إعادة رسم كل الإطارات بالمقاس نفسه.';

const atlas = (o: { key: string; label: string; file: string; fp: DefaultFingerprint; line: number; skin: 'classic' | 'scout' | 'both'; pose: string }): SiteIdentityKeyDef => ({
	key: o.key, group: 'character', label: o.label, kind: 'raster',
	description: `لوحة إطارات (sprite atlas) لشخصية بيبو: ${o.pose}. مقاسها ثابت 1774×887 لأن robot.js يقصّ الإطارات بإحداثيات مطلقة.`,
	allowedMimes: ['image/png'], maxBytes: ATLAS_MAX_BYTES, dimensions: { exact: { width: 1774, height: 887 } },
	defaultAsset: { type: 'file', path: o.file }, defaultFingerprint: o.fp,
	usages: [
		{ where: `robot.js يحمّلها لشخصية ${o.skin === 'classic' ? 'الشكل الكلاسيكي (skin الافتراضي)' : o.skin === 'scout' ? 'شكل الكشّاف (skin=scout)' : 'الشكلين'}`, ref: `${ROBOT_JS}:${o.line}` },
		{ where: 'المساعد الذكي: المكوّن <app-bebo-avatar> ينشئ <cute-robot> (واجهة المساعد العائمة)', ref: 'src/app/sheards/bebo-avatar/bebo-avatar.ts:61' },
	],
	notWiredReason: ATLAS_REASON,
	notes: ['حجم الملف الحالي أكبر من 512KB؛ سقف هذا المفتاح 2MB (استثناء موثّق: لا يمكن أن تكون اللوحة البديلة أصغر من اللوحة الحالية بكثير)'],
});

const PNG_ATLAS = (sha256: string, byteSize: number): DefaultFingerprint => ({ mime: 'image/png', width: 1774, height: 887, byteSize, sha256 });

const EMPTY_JSON_SHA = createHash('sha256').update('{}').digest('hex');
const TOKENS_SOURCE = 'src/styles.css (:root = الداكن، .theme-light = الفاتح) - مرآة في TOKEN_REGISTRY (src/config/site-identity-tokens.ts)';
/** the unwired reason of tokens.typography (the only token key that is not in WIRED_KEYS by default) */
const TYPOGRAPHY_REASON = 'يقرأ الخط العام من المتغيّر --font-family (يُوجَّه إليه --font-body و --font-heading و --font-numeric في النظام التصميمي)؛ لا تُعرض هذه الرسالة إلا إن أُلغي ربط المفتاح.';
const tokenKey = (o: { key: string; label: string; description: string; wired: boolean }): SiteIdentityKeyDef => ({
	key: o.key, group: 'token', label: o.label, description: o.description, kind: 'json', allowedMimes: ['application/json'], maxBytes: 8 * 1024, dimensions: {},
	defaultAsset: { type: 'tokens', source: TOKENS_SOURCE },
	defaultFingerprint: { mime: 'application/json', width: null, height: null, byteSize: 2, sha256: EMPTY_JSON_SHA, note: 'الافتراضي = لا تجاوزات ({}) ؛ القيم الافتراضية الفعلية لكل رمز في TOKEN_REGISTRY' },
	usages: [{ where: 'طبقة <style id="ws-identity-tokens"> تُحقن في <head> فقط عند وجود تجاوزات (وإلا لا شيء)', ref: 'src/styles.css :root / .theme-light' }],
	notWiredReason: o.wired ? 'لا يقرأ أي مكوّن في الواجهة طبقة الرموز هذه إلا بعد ربط حاقن الرموز (ws-identity-tokens)؛ لا تُعرض هذه الرسالة إلا إن أُلغي ربط المفتاح.' : TYPOGRAPHY_REASON,
	notes: ['تُخزَّن كائنًا متفرقًا {"--اسم":"قيمة"}: الرموز المعدّلة فقط؛ الألوان والخطوط المكتوبة حرفيًا في المكوّنات غير مرتبطة.'],
});

/** the order here is the order shown in the admin page */
export const SITE_IDENTITY_REGISTRY: readonly SiteIdentityKeyDef[] = [
	{
		key: 'logo.mark', group: 'logo', label: 'شعار وسيط AI (العلامة)',
		description: 'علامة W المتدرجة (تيل ← أزرق) التي تظهر في الشريط العلوي والتذييل والقائمة الجانبية وشاشات التحميل وصفحات الدخول والتسجيل والخطأ والمساعد.',
		kind: 'raster', allowedMimes: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: RASTER_MAX_BYTES, dimensions: MARK_DIMS,
		defaultAsset: { type: 'file', path: '/images/waseet-mark.png' }, defaultFingerprint: MARK_FP,
		usages: [
			{ where: 'شريط الموقع العلوي (ارتفاع 34)', ref: 'src/app/sheards/navbar/navbar.html:34' },
			{ where: 'تذييل الموقع (ارتفاع 36)', ref: 'src/app/sheards/footer/footer.html:8' },
			{ where: 'القائمة الجانبية للوحات', ref: 'src/app/sheards/dashboard/sidebar/sidebar.html:6' },
			{ where: 'شريط لوحات التحكم', ref: 'src/app/sheards/dashboard/nav-dashboard/nav-dashboard.html:3' },
			{ where: 'شاشة تحميل الصفحات', ref: 'src/app/sheards/page-loader/page-loader.html:7' },
			{ where: 'صفحة الدخول', ref: 'src/app/pages/auth/login/login.html:16' },
			{ where: 'صفحة التسجيل (موضعان)', ref: 'src/app/pages/auth/register/register.html:104,367' },
			{ where: 'صفحة التحقق من الرمز', ref: 'src/app/pages/auth/verify-otp/verify-otp.html:24' },
			{ where: 'صفحة الخطأ', ref: 'src/app/pages/system-errors/error-page/error-page.html:16' },
			{ where: 'صفحة المساعد', ref: 'src/app/pages/assistant/assistant-page.ts:55' },
			{ where: 'أيقونة إشعارات المتصفح (Notification API)', ref: 'src/app/core/services/notification-sound.service.ts:118' },
		],
		notWiredReason: NOT_READ,
		notes: ['الملف الحالي 614×371 (نسبة 1.655): الواجهات تحدّد الارتفاع فقط (height=34/36/30) والعرض تلقائي، لذلك تُقيَّد النسبة بين 1 و3 كي لا ينكسر التخطيط.',
			'هو نفسه بايتًا ببايت ملف assets/brand/waseet-mark.png (مفتاحا logo.boot و favicon.tab).'],
	},
	{
		key: 'logo.boot', group: 'logo', label: 'شعار شاشة التحميل الأولى',
		description: 'الشعار الذي تعرضه صفحة index.html قبل أن يبدأ التطبيق (يُرسم قبل تشغيل أي JavaScript).',
		kind: 'raster', allowedMimes: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: RASTER_MAX_BYTES, dimensions: MARK_DIMS,
		defaultAsset: { type: 'file', path: '/assets/brand/waseet-mark.png' }, defaultFingerprint: MARK_FP,
		usages: [{ where: 'شاشة التحميل الساكنة داخل الصفحة الأولى', ref: 'src/index.html:222' }, { where: 'شاشة تحميل التطبيق (app.ts) - نفس المفتاح، لا ملف مختلف', ref: 'src/app/app.ts:27' }],
		notWiredReason: 'تُرسم شاشة التحميل الأولى من index.html قبل تشغيل JavaScript، أي قبل أن يتوفر ملف الهوية؛ لا يمكن تبديلها من الهوية المخزّنة دون تغيير آلية الإقلاع.',
	},
	{
		key: 'logo.email', group: 'logo', label: 'شعار رسائل البريد',
		description: 'الشعار في رأس كل رسالة بريد عن العمليات (قالب email-shell). الرسائل المرسلة سابقًا لا تُعاد كتابتها أبدًا.',
		kind: 'raster', allowedMimes: ['image/png'], maxBytes: 200 * 1024, dimensions: { minWidth: 68, minHeight: 32, maxWidth: 1024, maxHeight: 1024, aspectMin: 1, aspectMax: 3 },
		defaultAsset: { type: 'file', path: '/images/waseet-mark.png' }, defaultFingerprint: MARK_FP,
		usages: [{ where: 'رأس قالب البريد: <img src="{EMAIL_ASSET_BASE_URL|site}/images/waseet-mark.png" width="34">', ref: 'src/utils/email-shell.ts (renderEmailShell) <- src/services/site-identity-cache.ts' }],
		notWiredReason: 'قالب البريد في الخادم يقرأ الشعار من ذاكرة الهوية (site-identity-cache) ويرجع إلى EMAIL_ASSET_BASE_URL/images/waseet-mark.png؛ الربط جاهز في الخادم وينتظر تفعيل المفتاح في WIRED_KEYS؛ بريد PNG فقط (عملاء البريد لا يعرضون SVG / WebP).',
		notes: ['PNG فقط لأن Gmail/Outlook لا يعرضان SVG ولا WebP بشكل موثوق.'],
	},
	{
		key: 'social.og', group: 'logo', label: 'صورة معاينة الروابط (Open Graph)',
		description: 'صورة 1200×630 التي تظهر عند مشاركة رابط الموقع في واتساب وغيره (ليست الشعار).',
		kind: 'raster', allowedMimes: ['image/png', 'image/jpeg'], maxBytes: RASTER_MAX_BYTES, dimensions: { exact: { width: 1200, height: 630 } },
		defaultAsset: { type: 'file', path: '/assets/social/waseetai-og-v3.jpg' },
		defaultFingerprint: { mime: 'image/jpeg', width: 1200, height: 630, byteSize: 39921, sha256: '72243b991d6431c08174182031cd912640c2f9530525439e5a2c3f4381c32f41' },
		usages: [{ where: 'og:image / og:image:url / og:image:secure_url / twitter:image (عنوان مطلق ثابت)', ref: 'src/index.html:49-51,59' }, { where: 'اختبار ثابت يحرس أن الصورة ليست الشعار', ref: 'src/app/og-link-preview.static.spec.ts:49' }],
		notWiredReason: 'وسوم og:image ثابتة في index.html وبعنوان مطلق: تقرؤها برامج المعاينة دون تشغيل JavaScript، فلا يمكن تبديلها من الهوية المخزّنة.',
	},
	{
		key: 'favicon.tab', group: 'favicon', label: 'أيقونة تبويب المتصفح',
		description: 'الأيقونة التي يعرضها المتصفح في التبويب (وسم <link rel="icon">).',
		kind: 'raster', allowedMimes: ['image/png', 'image/svg+xml'], maxBytes: RASTER_MAX_BYTES, dimensions: { minWidth: 32, minHeight: 32, maxWidth: 1024, maxHeight: 1024, aspectMin: 0.5, aspectMax: 2 },
		defaultAsset: { type: 'file', path: '/assets/brand/waseet-mark.png' }, defaultFingerprint: MARK_FP,
		usages: [{ where: '<link rel="icon" type="image/png" href="assets/brand/waseet-mark.png">', ref: 'src/index.html:38' }],
		notWiredReason: NOT_READ,
		notes: ['الوسم ساكن في index.html: تحديثه وقت التشغيل من الهوية قرار الواجهة (القيمة الافتراضية = الوسم الحالي كما هو).', 'الملف الحالي غير مربّع (614×371) والمتصفح يقبله؛ لذلك النسبة المسموحة 0.5 – 2.'],
	},
	{
		key: 'favicon.ico', group: 'favicon', label: 'ملف favicon.ico الافتراضي',
		description: 'الملف الذي يطلبه المتصفح من /favicon.ico عندما لا يجد وسمًا (ثلاث صور 48/32/16).',
		kind: 'ico', allowedMimes: ['image/x-icon'], maxBytes: 256 * 1024, dimensions: { minWidth: 16, minHeight: 16, maxWidth: 256, maxHeight: 256, aspectMin: 1, aspectMax: 1 },
		defaultAsset: { type: 'file', path: '/favicon.ico' },
		defaultFingerprint: { mime: 'image/x-icon', width: 48, height: 48, byteSize: 15086, sha256: 'f9102be80297c0529207607be5277b4f90bca89d65988fa1771b91c7894e815f', entries: 3 },
		usages: [{ where: 'ملف ثابت في public/ يقدّمه الخادم الثابت؛ لا يُشار إليه في الشيفرة (يطلبه المتصفح مباشرة)', ref: 'public/favicon.ico' }],
		notWiredReason: 'يطلبه المتصفح مباشرة من الملف الثابت /favicon.ico ولا يمرّ بالتطبيق؛ تبديله يحتاج مسارًا في الخادم الثابت لا في الواجهة.',
	},
	{
		key: 'icon.ai', group: 'icon', label: 'أيقونة الذكاء الاصطناعي',
		description: 'العلامة الرسمية الوحيدة لـ«وسيط AI»: شبكة عقد (عقدة مركزية وست عقد و8 روابط) على لوحة 24×24 بخط stroke وبلون currentColor. تُرسم في كل بطاقة/شارة/شريط للذكاء الاصطناعي الحقيقي فقط.',
		kind: 'svg', allowedMimes: ['image/svg+xml'], maxBytes: SVG_MAX_BYTES, dimensions: { aspectMin: 0.99, aspectMax: 1.01 },
		defaultAsset: { type: 'inline-symbol', symbolId: 'i-ai', source: 'src/app/core/constants/ai-icon.ts (AI_ICON_INNER) - repeated as <symbol id="i-ai"> in 10 templates' },
		defaultFingerprint: { mime: 'image/svg+xml', width: 24, height: 24, byteSize: 338, sha256: '599249cf0c32d25e4f116a982c355d3321b54cad5a0d2324f9ba7c4263d95ed0', note: 'sha256 of AI_ICON_INNER (the inner markup, exact string of ai-icon.ts); the file public/tools/02-الايقونات/svg/i-ai.svg (sha256 9b7f3dda...) is the same geometry with a fixed teal stroke and is documentation, not a consumer' },
		usages: [
			{ where: '10 نسخ <symbol id="i-ai"> داخل القوالب (نفس الهندسة؛ stroke-width 1.8 في 8 منها و2 في client-overview و provider-overview؛ تنسيق المسافات يختلف)', ref: 'src/app/sheards/navbar/navbar.html:3; src/app/layouts/dashboard-layout/dashboard-layout.html:99; src/app/pages/dashboard/clients-overview/client-overview/client-overview.component.html:78; src/app/pages/dashboard/provider-overview/provider-overview/provider-overview.html:4; src/app/pages/dashboard/provider-overview/explore-requests/applay-request/applay-request.html:7; src/app/pages/dashboard/provider-overview/profile/profile-setup/profile-setup.html:14; src/app/pages/dashboard/provider-overview/business-models/accreditation/list/list.html:5; src/app/pages/dashboard/provider-overview/finance/wallet/wallet.html:3; src/app/pages/dashboard/supper-admin-overview/supper-admin-overview/supper-admin-overview.html:13; src/app/pages/dashboard/supper-admin-overview/sa-users/sa-users.html:15' },
			{ where: '62 موضع استهلاك <use href="#i-ai"> في 30 ملفًا (لوحات العميل والمزوّد والوسيط والمدير + مكوّن اختبار التخصص + إعدادات النظام)', ref: 'see IDENTITY-INVENTORY-2026-10-27.md (per file:line)' },
			{ where: 'تلوين الأيقونة بلون الذكاء الاصطناعي (CSS: svg use[href="#i-ai"])', ref: 'src/styles.css:239; public/assets/ws-site.css:74; public/assets/ws-light-polish.js:252' },
			{ where: 'حارس الهندسة: يفشل إذا انحرفت أي نسخة', ref: 'src/app/ai-icon.static.spec.ts; src/app/core/constants/ai-icon.ts' },
		],
		notWiredReason: NOT_READ,
		notes: ['لا تُغيَّر الهندسة ولا stroke-width ولا الألوان: أيقونات الوظائف (eye/bolt/alert) مفاتيح أخرى أو ليست هوية.',
			'نسخ الرمز الداخلية متطابقة هندسيًا؛ اثنتان فقط (client-overview و provider-overview) تستخدمان stroke-width=2 والباقي 1.8 - وهذا هو الشكل الحالي ويجب أن يبقى كما هو في الحالة الافتراضية.',
			'الأيقونة المخصّصة SVG مستقل: <img> لا يرث currentColor، لذا على الواجهة أن تحقنها كـ symbol أو تقبل لونها المرسوم.'],
	},
	atlas({ key: 'character.bebo.classic.sprites', label: 'بيبو الكلاسيكي: اللوحة الأساسية', file: '/bebo/robot-sprites.png', fp: PNG_ATLAS('da526dceca72f01fb61dbc47da3a4edea8efba551c3a05c379aad1c93dcfcd25', 907058), line: 7, skin: 'classic', pose: 'الوقوف والرمش والتحية والفرح' }),
	atlas({ key: 'character.bebo.classic.actions', label: 'بيبو الكلاسيكي: الحركات', file: '/bebo/robot-actions.png', fp: PNG_ATLAS('1e9848c1a329267ad25fc4b2542fad10a3d6728a4cd9953c250ad07bb68af491', 948421), line: 8, skin: 'classic', pose: 'القفز والمشي والسحب والهبوط' }),
	atlas({ key: 'character.bebo.classic.speaking', label: 'بيبو الكلاسيكي: التحدث', file: '/bebo/robot-speaking.png', fp: PNG_ATLAS('be8059ae8b79af4b6eec30c5b03c21045db8cba464209293809a8daf23ca2e19', 946116), line: 9, skin: 'classic', pose: 'وضعية التحدث' }),
	atlas({ key: 'character.bebo.classic.antics', label: 'بيبو الكلاسيكي: الحركات الاستعراضية', file: '/bebo/robot-antics.png', fp: PNG_ATLAS('cbd133a8d133956df99fc6ab095c845977662fb427839fb76484d35148830ae7', 999956), line: 10, skin: 'classic', pose: 'حركات استعراضية تُستدعى بأوامر' }),
	atlas({ key: 'character.bebo.classic.emotions', label: 'بيبو الكلاسيكي: المشاعر', file: '/bebo/robot-emotions.png', fp: PNG_ATLAS('6fe556c7fdbca10fd63217bb6fabfd6efa15508f5597401a2a0918833227efd4', 1019693), line: 11, skin: 'classic', pose: 'مشاعر (ضحك، بكاء ...)' }),
	atlas({ key: 'character.bebo.classic.kitten', label: 'بيبو الكلاسيكي: القطة', file: '/bebo/kitten-sprites.png', fp: PNG_ATLAS('bf5849a6902c7f8bf02404bd8e3e390b666ec78a7ec4d16eec511bbbaeee9147', 1024088), line: 12, skin: 'classic', pose: 'القطة المرافقة' }),
	atlas({ key: 'character.bebo.scout.sprites', label: 'بيبو الكشّاف: اللوحة الأساسية', file: '/bebo/scout/guide-sprites.png', fp: PNG_ATLAS('ef923ecd448c173d386a261d0de93616fdb0abc679b7efd21a93746513087732', 1341322), line: 17, skin: 'scout', pose: 'الوقوف والرمش والتحية' }),
	atlas({ key: 'character.bebo.scout.actions', label: 'بيبو الكشّاف: الحركات', file: '/bebo/scout/guide-actions.png', fp: PNG_ATLAS('a4c8dae6689ac49f61682a376cb2424f00ad67e8ae77fde1af4989094f429e67', 1332842), line: 18, skin: 'scout', pose: 'القفز والمشي والسحب والهبوط' }),
	atlas({ key: 'character.bebo.scout.speaking', label: 'بيبو الكشّاف: التحدث', file: '/bebo/scout/guide-speaking.png', fp: PNG_ATLAS('59b7ca1ebc64a954d73c6b27c0b94e51c91829e3750d8924147bdf2e921ae573', 1336954), line: 19, skin: 'scout', pose: 'وضعية التحدث' }),
	atlas({ key: 'character.bebo.scout.antics', label: 'بيبو الكشّاف: الحركات الاستعراضية', file: '/bebo/scout/guide-antics.png', fp: PNG_ATLAS('6f672d703507006d328a1c76143f7cf43048667d4fa326bcfe1449a6157ca7ea', 1342615), line: 20, skin: 'scout', pose: 'حركات استعراضية' }),
	atlas({ key: 'character.bebo.scout.emotions', label: 'بيبو الكشّاف: المشاعر', file: '/bebo/scout/guide-emotions.png', fp: PNG_ATLAS('3a23aa7b07348d18d6ed8be7437af749bea1844575342bde2146da1801b3936c', 1375284), line: 21, skin: 'scout', pose: 'مشاعر' }),
	atlas({ key: 'character.bebo.scout.kitten', label: 'بيبو الكشّاف: القطة', file: '/bebo/scout/kitten-sprites.png', fp: PNG_ATLAS('bf5849a6902c7f8bf02404bd8e3e390b666ec78a7ec4d16eec511bbbaeee9147', 1024088), line: 22, skin: 'scout', pose: 'القطة المرافقة (نفس بايتات القطة الكلاسيكية)' }),
	atlas({ key: 'character.bebo.traffic', label: 'بيبو: لوحة إشارات المرور', file: '/bebo/scout/guide-traffic.png', fp: PNG_ATLAS('fc975b8d41a646abff3890401c9b9eb290a5ade3a6ae5f0b7cf64d1806572d61', 1595275), line: 13, skin: 'both', pose: 'إشارات المرور' }),
	atlas({ key: 'character.bebo.expressions', label: 'بيبو: لوحة التعبيرات', file: '/bebo/scout/guide-expressions.png', fp: PNG_ATLAS('fdbdac15de8ae1ea32a3aeeca3c600c850d832eadb382e23b27fc7c51ca59e0b', 1402278), line: 14, skin: 'both', pose: 'تعبيرات الوجه' }),
	tokenKey({ key: 'tokens.colors.light', label: 'ألوان الوضع الفاتح', wired: true, description: 'ألوان المتغيّرات المركزية (CSS custom properties) في الوضع الفاتح: الخلفيات والنصوص والحدود وألوان العلامة. تُحقن كطبقة تجاوز فوق styles.css ولا تُغيّر الألوان المكتوبة حرفيًا داخل المكوّنات.' }),
	tokenKey({ key: 'tokens.colors.dark', label: 'ألوان الوضع الداكن', wired: true, description: 'ألوان المتغيّرات المركزية (CSS custom properties) في الوضع الداكن (الافتراضي). طبقة تجاوز فوق styles.css؛ لا تمسّ الألوان المكتوبة حرفيًا داخل المكوّنات.' }),
	tokenKey({ key: 'tokens.layout', label: 'الأبعاد العامة', wired: true, description: 'العرض الأقصى للمحتوى واستدارة الزوايا (--container --radius --radius-sm).' }),
	tokenKey({ key: 'tokens.typography', label: 'الخط العام', wired: true, description: 'عائلة الخط العامة (--font-family). الافتراضي Tajawal المضمّن في الموقع؛ لا يحمّل الموقع خطوطًا خارجية، فيعمل أي اسم آخر فقط إن كان الخط مثبّتًا على جهاز الزائر.' }),
];

/**
 * KEYS THAT REALLY HAVE A CONSUMER READING THEM THROUGH THE IDENTITY SERVICE. The ONLY place `wired` comes from: edited by the coordinator when an FE (or BE) consumer lands, never through an API.
 * Empty on purpose: today nothing reads the identity service yet, so no key is editable (the page shows every key, its default, its usages and why it is not wired).
 */
export const WIRED_KEYS: readonly string[] = [
	'logo.mark', 'logo.boot', 'logo.email', 'favicon.tab', 'icon.ai',
	'character.bebo.classic.sprites', 'character.bebo.classic.actions', 'character.bebo.classic.speaking', 'character.bebo.classic.antics', 'character.bebo.classic.emotions', 'character.bebo.classic.kitten',
	'character.bebo.scout.sprites', 'character.bebo.scout.actions', 'character.bebo.scout.speaking', 'character.bebo.scout.antics', 'character.bebo.scout.emotions', 'character.bebo.scout.kitten',
	'character.bebo.traffic', 'character.bebo.expressions',
	// design tokens (round 5). tokens.typography joined after the FE proved the identical default rendering of the --font-family routing (design-system --font-body/heading/numeric)
	'tokens.colors.light', 'tokens.colors.dark', 'tokens.layout', 'tokens.typography',
];

const BY_KEY: ReadonlyMap<string, SiteIdentityKeyDef> = new Map(SITE_IDENTITY_REGISTRY.map(d => [d.key, d]));
export const IDENTITY_KEYS: readonly string[] = SITE_IDENTITY_REGISTRY.map(d => d.key);
export const identityDef = (key: string): SiteIdentityKeyDef | null => BY_KEY.get(key) ?? null;
export const isKnownIdentityKey = (key: string): boolean => BY_KEY.has(key);
export const isWiredKey = (key: string, wired: readonly string[] = WIRED_KEYS): boolean => wired.includes(key) && BY_KEY.has(key);
export const KEY_PATTERN = /^[a-z]+(?:\.[a-z0-9-]+)+$/;

/** the size ceiling that applies to an upload for this key and this (sniffed) mime */
export const maxBytesFor = (def: SiteIdentityKeyDef, mime: string): number => (mime === 'image/svg+xml' ? Math.min(def.maxBytes, SVG_MAX_BYTES) : def.maxBytes);

/** Arabic one-liners describing what a replacement must satisfy (shown on the page, derived so they can never disagree with the rule) */
export function describeRules(def: SiteIdentityKeyDef): string[] {
	const out: string[] = [];
	if (def.kind === 'json') {
		return ['الصيغة: كائن JSON متفرّق {"--اسم":"قيمة"} (أسماء الرموز المعرّفة لهذا العنصر فقط)', `الحجم الأقصى: ${Math.round(def.maxBytes / 1024)}KB`, 'القيم: ألوان (hex/rgb/rgba/hsl/hsla) أو تدرّج خطي أو ظل أو طول (px/rem) أو قائمة خطوط، دون url أو var أو ; أو أقواس معقوفة أو @ أو تعليقات', 'القيم المطابقة للافتراضي تُسقط تلقائيًا؛ كائن فارغ مرفوض (للعودة للافتراضي استخدم «استعادة الافتراضي»)'];
	}
	const names: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/svg+xml': 'SVG', 'image/x-icon': 'ICO' };
	out.push(`الصيغ المسموحة: ${def.allowedMimes.map(m => names[m] ?? m).join('، ')}`);
	const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toString().replace(/\.0+$/, '')}MB` : `${Math.round(n / 1024)}KB`);
	out.push(`الحجم الأقصى: ${kb(def.maxBytes)}${def.allowedMimes.includes('image/svg+xml') ? ` (SVG: ${kb(Math.min(def.maxBytes, SVG_MAX_BYTES))})` : ''}`);
	const d = def.dimensions;
	if (d.exact) out.push(`المقاس المطلوب بالضبط: ${d.exact.width}×${d.exact.height}`);
	else {
		if (d.minWidth || d.minHeight) out.push(`أصغر مقاس: ${d.minWidth ?? 1}×${d.minHeight ?? 1}`);
		if (d.maxWidth || d.maxHeight) out.push(`أكبر مقاس: ${d.maxWidth ?? ABSOLUTE_MAX_SIDE}×${d.maxHeight ?? ABSOLUTE_MAX_SIDE}`);
		if (d.aspectMin !== undefined || d.aspectMax !== undefined) out.push(d.aspectMin !== undefined && d.aspectMax !== undefined && d.aspectMax - d.aspectMin <= 0.02 ? 'يجب أن تكون الصورة مربّعة' : `نسبة العرض إلى الارتفاع بين ${d.aspectMin ?? 0} و${d.aspectMax ?? '∞'}`);
	}
	return out;
}

/**
 * Files that exist in the FE repo and look like identity but are deliberately NOT keys (no consumer reads them today, or they are not identity). Fingerprints let the inventory prove "nothing was touched".
 * Register one as a key only when a real consumer appears.
 */
export const UNREGISTERED_PRESENT_ASSETS: ReadonlyArray<{ path: string; reason: string; sha256: string }> = [
	{ path: 'public/assets/waseetai.svg', reason: 'الشعار الكامل WASEET AI (متجه 1000×1000، 40143 بايت): لا يُشار إليه من أي ملف في الواجهة', sha256: 'c16849e1a3b6096059ac545989657c98a32aad5e15f3b393f41441963eceebea' },
	{ path: 'public/assets/social/waseetai-og-v1.png', reason: 'نسخة قديمة من صورة المعاينة: غير مشار إليها (الحالية v3)', sha256: 'd69ae60fdd9601fb67c2ee246634c9104e70abdc30103a599e98883c40bce89a' },
	{ path: 'public/assets/social/waseetai-og-v2.jpg', reason: 'نسخة قديمة من صورة المعاينة: غير مشار إليها (الحالية v3)', sha256: '0487b1cc480df3dbbb2823782a49955879cd221edac30962ab505bd0a58707f0' },
	{ path: 'public/assets/images/robot-hand-side.png', reason: 'رسم روبوت: لا مستهلك في الواجهة', sha256: '0e2fdcc759a97ce3e4232aab1baf12709115a134c13e4303dfe2c3c498a409fb' },
	{ path: 'public/assets/images/vision-robot.png', reason: 'رسم روبوت: لا مستهلك في الواجهة', sha256: '72e1cd01e7abf3684d4f617c90a3b1fe49444b3057c82716d8e3c718411fe967' },
	{ path: 'public/assets/images/whywaseetReboot.png', reason: 'رسم روبوت: لا مستهلك في الواجهة', sha256: '7da8c9ef8395f6bec73ecd1e7d5be4f77dbe59bbfbfb1a25e54789eee47945ba' },
	{ path: 'public/assets/images/reboot.png', reason: 'رسم روبوت: لا مستهلك في الواجهة', sha256: '885eb1a5da366e14f1d7d64119d102d503ddee502826ab4e0011e9cab23d5657' },
	{ path: 'public/assets/images/aima.png', reason: 'رسم: لا مستهلك في الواجهة', sha256: '196bd31b24a57a53d112cb0e5811bead57cb0e3e37d9d5461826229189b4c090' },
];

/** shown on the page so nobody expects these in the identity manager */
export const NOT_IDENTITY_NOTES: readonly string[] = [
	'اسم المنصة ليس مفتاح هوية: يبقى إعداد «اسم المنصة» الحالي.',
	'أيقونات الوظائف (الجرس، العين، البرق، التنبيه، المحفظة ...) وأيقونات مكتبة الذكاء الاصطناعي الشبيهة (#ws-trust-ai و #ws-ai-*) ليست «أيقونة الذكاء الاصطناعي» الرسمية #i-ai ولا تُدار هنا.',
	'شعارات المنصات الاجتماعية وشعارات الدفع والبنوك وأعلام الدول علامات تجارية لأطراف أخرى ولا تُستبدل.',
	'كل ما يرفعه المستخدمون (صور الحسابات، الأعمال، وثائق الهوية، صور الخدمات، المواد التسويقية) ليس هوية المنصة.',
	'صور المحتوى والتسويق في public/assets/images (service-*، dashboard-mockup، contract-*، message* ...) ليست هوية.',
	'العلامات المائية ومقاسات الشعار (logo-xs..xl) تُشتق من الشعار بـ CSS ولا ملف مستقل لها.',
	'الألوان والخطوط تُدار هنا فقط عبر المتغيّرات المركزية في styles.css (:root و .theme-light)؛ الألوان والخطوط المكتوبة حرفيًا داخل المكوّنات و Tailwind غير مرتبطة ولا تتغيّر.',
];
