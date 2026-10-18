// Provider "new project" description AI (ai-review.gateway.ts): turns the raw model reply into discrete, approvable candidates.
//
// The WaseetAI text endpoints take only {title} / {description}: the vendor prompt cannot be given our field limit, so the limit is enforced
// HERE on the finished reply, before anything is offered for approval:
//   1. clean presentation markup, 2. split into candidates (dropping the introduction / closing advice),
//   3. a candidate over the limit is cut ONLY at a complete sentence boundary <= limit (never mid-sentence), or dropped.
// Unit: UTF-16 code units (`String.length`), identical to the textarea `maxlength`, the on-screen counter (`descCount`) and the FE guard.

export const AI_DESCRIPTION_MAX_CHARS = 1500;
/** The raw reply is bounded so a runaway stream cannot grow without limit. */
export const AI_DESCRIPTION_RAW_MAX_CHARS = 30000;
export const AI_DESCRIPTION_MAX_CANDIDATES = 5;
/** A sentence-boundary cut that leaves less than this is not a usable description. */
const MIN_TRIMMED_CHARS = 120;

export interface AiDescriptionCandidate {
  id: string;
  text: string;
  length: number;
  /** True when the model text was longer than the limit and was cut at a complete sentence boundary. */
  trimmed: boolean;
}

export interface AiDescriptionCandidates {
  candidates: AiDescriptionCandidate[];
  /** Candidates the model wrote that could not be brought under the limit (and were not offered). */
  rejectedTooLong: number;
}

const norm = (s: string) => s.normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه');
const unmark = (line: string) => line.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*•]\s+/, '').replace(/\*\*|__/g, '').trim();

const ORD = '(?:الاول|الاولي|الثاني|الثانيه|الثالث|الثالثه|الرابع|الرابعه|الخامس|الخامسه|[0-9٠-٩]+)';
const OPTION_HEADING = new RegExp(`^(?:(?:الخيار|الاقتراح|المقترح|الصياغه|النسخه|الوصف|الصيغه)\\s+${ORD}|(?:option|alternative|version|suggestion|draft)\\s+\\d+)\\s*(?:[:：\\-–—.)]\\s*(.*))?$`, 'i');
const ADVICE_HEADING = /^(?:نصائح|نصيحه|ملاحظات|ملاحظه|ملحوظه|توصيه|توصيات|انصحك|يمكنك اختيار|اختر الصياغه|tips?|notes?|recommendations?)(?:\s|[:：]|$)/i;
const PREAMBLE_LINE = /^(?:بالتاكيد|بالطبع|اكيد|حسنا|تفضل|اليك|هذه|هذا|اقدم|سوف|sure|certainly|of course|here)\b[^\n]{0,200}[:：]$/i;

/** Plain editable text: presentation markdown never reaches the field. */
export function cleanDescriptionText(markdown: string): string {
  return String(markdown ?? '').replace(/\r\n?/g, '\n')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^\s*>\s?/gm, '').replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const SENTENCE_END = /[.!?؟۔…。]/;

/**
 * Cuts `text` to at most `max` characters at the last COMPLETE sentence (or list line) boundary.
 * Returns null when no boundary leaves a usable remainder: a sentence is never cut in the middle.
 */
export function cutAtSentenceBoundary(text: string, max: number): string | null {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  let best = -1;
  for (let i = max; i > 0; i--) {
    const ch = window[i - 1];
    const next = window[i]; // may be undefined only when i === window.length
    const endsSentence = SENTENCE_END.test(ch) && (next === undefined || /\s/.test(next));
    const endsLine = next === '\n';
    if (endsSentence || endsLine) { best = i; break; }
  }
  if (best < MIN_TRIMMED_CHARS) return null;
  const cut = text.slice(0, best).trimEnd();
  if (!cut || cut.length > max) return null;
  return cut;
}

function splitRaw(raw: string): string[] {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  const drafts: string[][] = [];
  let current: string[] | null = null;
  let sawHeading = false;
  let inAdvice = false;
  const preamble: string[] = [];
  for (const line of lines) {
    const bare = norm(unmark(line));
    const m = OPTION_HEADING.exec(bare);
    if (m && bare.length <= 200) {
      sawHeading = true; inAdvice = false;
      current = [];
      // Keep the ORIGINAL (un-normalised) inline text after the colon, if any.
      const colon = unmark(line).search(/[:：]/);
      const inline = m[1] && colon >= 0 ? unmark(line).slice(colon + 1).trim().replace(/^["“«]|["”»]$/g, '') : '';
      if (inline) current.push(inline);
      drafts.push(current);
      continue;
    }
    if (sawHeading && ADVICE_HEADING.test(bare)) { inAdvice = true; current = null; }
    if (inAdvice) continue;
    if (current) current.push(line); else preamble.push(line);
  }
  if (sawHeading) return drafts.map(d => d.join('\n'));
  // Single description: drop an introductory "here is ..." line and a trailing advice section.
  const body = preamble.slice();
  while (body.length && !body[0].trim()) body.shift();
  if (body.length && PREAMBLE_LINE.test(norm(unmark(body[0])))) body.shift();
  const adviceAt = body.findIndex((l, i) => i > 0 && ADVICE_HEADING.test(norm(unmark(l))));
  return [(adviceAt > 0 ? body.slice(0, adviceAt) : body).join('\n')];
}

export function buildDescriptionCandidates(raw: string, max = AI_DESCRIPTION_MAX_CHARS): AiDescriptionCandidates {
  const seen = new Set<string>();
  const candidates: AiDescriptionCandidate[] = [];
  let rejectedTooLong = 0;
  for (const part of splitRaw(String(raw ?? '').slice(0, AI_DESCRIPTION_RAW_MAX_CHARS))) {
    const text = cleanDescriptionText(part);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const fitted = cutAtSentenceBoundary(text, max);
    if (fitted === null) { rejectedTooLong++; continue; }
    if (candidates.length >= AI_DESCRIPTION_MAX_CANDIDATES) break;
    candidates.push({ id: `option-${candidates.length + 1}`, text: fitted, length: fitted.length, trimmed: fitted.length < text.length });
  }
  return { candidates, rejectedTooLong };
}
