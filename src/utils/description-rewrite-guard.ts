// Create-request "تحسين وصياغة AI" is REWRITING ONLY: the client writes the title and the description, the AI may only restate the existing text.
// The WaseetAI enhance endpoint takes nothing but {description} (no instruction field, its prompt is the vendor's), so the rewrite-only rule is enforced
// on OUR side: nothing is sent unless the client wrote enough, and a reply is accepted only if it still looks like a rewrite of that text.
// The FE keeps a mirror of this file (create-request/description-rewrite-guard.ts): keep both in sync.

export const REWRITE_MIN_DESCRIPTION_CHARS = 30;
export const REWRITE_MIN_DESCRIPTION_WORDS = 6;
export const REWRITE_INPUT_REQUIRED_MESSAGE = 'اكتب عنوان الطلب ووصفه أولًا، ثم استخدم تحسين الصياغة.';

const GENERIC_TITLES = new Set([
  'تجربة', 'اختبار', 'مشروع', 'مشروع جديد', 'طلب', 'طلب جديد', 'خدمة', 'خدمة جديدة',
  'test', 'testing', 'project', 'new project', 'request', 'service'
]);

export function isMeaningfulProjectTitle(title: string): boolean {
  const normalized = title.replace(/[\p{P}\p{S}_]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(word => word.length > 1);
  return normalized.length >= 8 && words.length >= 2 && !GENERIC_TITLES.has(normalized.toLowerCase());
}

const wordsOf = (text: string) => text.replace(/[\p{P}\p{S}_]+/gu, ' ').split(/\s+/).filter(w => w.length > 1);

/** True when the client wrote enough to be restated: a few words are not a draft to rewrite. */
export function hasEnoughDescriptionToRewrite(description: string): boolean {
  const text = description.trim();
  return text.length >= REWRITE_MIN_DESCRIPTION_CHARS && wordsOf(text).length >= REWRITE_MIN_DESCRIPTION_WORDS;
}

export function canRewrite(title: string, description: string): boolean {
  return isMeaningfulProjectTitle(title.trim()) && hasEnoughDescriptionToRewrite(description);
}

// Assistant chatter that must never end up inside the client's request ("يبدو أنك قمت بنسخ…", "إليك صياغة…").
// \b does not work for Arabic letters, so words are delimited by "not a letter" look-arounds.
const word = (alternatives: string) => new RegExp(`(?<![\\p{L}])(?:${alternatives})(?![\\p{L}])`, 'iu');
const META_PATTERNS: RegExp[] = [
  word('يبدو (أنك|انك|أن|ان)'), word('إليك|اليك'), word('بالتأكيد|بالطبع|حسنًا|حسنا|حسناً'), word('فيما يلي'),
  word('هذه (هي )?(صياغة|نسخة|المسودة)'), word('صياغة (محسّنة|محسنة|مقترحة|جديدة)'), word('نسخ(ت|تَ)? نص'), word('خيارات سابقة'),
  word('(لا|لن) (يمكنني|أستطيع|استطيع)'), word('عذرًا|عذرا|عذراً|أعتذر|اعتذر'), word('كنموذج (ذكاء|لغ)'), word('تم (تحسين|إعادة صياغة|تعديل) (النص|الوصف)'),
  word("here(?:'s| is| are)"), word('sure|certainly|as an ai'), word("i (cannot|can't|apologi[sz]e)")
];
const MARKDOWN = /\*\*|__|^\s{0,3}#{1,6}\s|```|^\s*\|?\s*-{3,}\s*\|/m;

const digitsOf = (text: string): Set<string> => {
  const latin = text.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  return new Set(latin.match(/\d+(?:[.,]\d+)?/g) ?? []);
};
const stem = (w: string) => w.replace(/[ًٌٍَُِّْـ]/g, '').replace(/^(وال|بال|لل|ال|و)(?=.{3,})/, '');

export type RewriteCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'meta' | 'markdown' | 'invented-numbers' | 'length' | 'not-a-rewrite' };

/** Accepts the AI reply only when it is a plain-text restatement of `input`; anything else is rejected and the client's text stays untouched. */
export function checkRewriteOutput(input: string, output: string): RewriteCheck {
  const src = input.trim();
  const text = output.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (MARKDOWN.test(text)) return { ok: false, reason: 'markdown' };
  // A phrase the client wrote themselves is theirs to keep; only phrases the AI added count as chatter.
  if (META_PATTERNS.some(p => p.test(text) && !p.test(src))) return { ok: false, reason: 'meta' };
  const known = digitsOf(src);
  if ([...digitsOf(text)].some(n => !known.has(n))) return { ok: false, reason: 'invented-numbers' };
  if (text.length > 2000 || text.length > Math.max(src.length * 2.5, 300) || text.length < src.length * 0.4) return { ok: false, reason: 'length' };
  const srcStems = [...new Set(wordsOf(src).filter(w => w.length >= 4).map(stem))];
  if (srcStems.length >= 4) {
    const outText = wordsOf(text).map(stem).join(' ');
    const kept = srcStems.filter(s => outText.includes(s)).length;
    if (kept / srcStems.length < 0.4) return { ok: false, reason: 'not-a-rewrite' };
  }
  return { ok: true, text };
}
