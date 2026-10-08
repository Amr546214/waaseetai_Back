// Create-request "تحسين وصياغة AI" works on text the client already wrote: no generation from nothing.
// The WaseetAI enhance endpoint takes nothing but {description} (no instruction field, its prompt is the vendor's), so the rewrite-only rule is enforced
// on OUR side only for the INPUT: nothing is sent unless the client wrote enough. The reply is accepted as-is (empty refused, cut to 2000).
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

export const REWRITE_MAX_CHARS = 2000;

export type RewriteCheck = { ok: true; text: string } | { ok: false; reason: 'empty' };

/**
 * The AI reply is shown as WaseetAI wrote it (owner decision): assistant phrasing and markdown are NOT rejected.
 * Only an empty reply is refused, and an over-long one is cut to the description limit so the field can never exceed it.
 */
export function checkRewriteOutput(_input: string, output: string): RewriteCheck {
  const text = output.trim();
  if (!text) return { ok: false, reason: 'empty' };
  return { ok: true, text: text.slice(0, REWRITE_MAX_CHARS) };
}
