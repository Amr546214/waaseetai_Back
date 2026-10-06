import { normalizeDigits } from './llm.payload';

// Honesty verifier. A model output is accepted only when everything it cites exists in what was actually sent:
//  - ids returned are a subset of the ids sent;
//  - basedOn[] paths resolve to a non-empty value in the input;
//  - quoted strings are literal substrings of the input text;
//  - numbers written inside free-text fields appear in the input (Arabic digits normalised).
// Score / percentage fields are NOT matched literally (zod fixes their type and range).

export interface GroundingSpec {
  /** output path → input path: every value at the output path must be among the values at the input path (wildcards `[]`). */
  ids?: Array<{ output: string; input: string }>;
  /** output path holding basedOn arrays (each entry a field path that must exist and be non-empty in the input). */
  basedOn?: string[];
  /** output paths whose strings must be literal substrings of the input text (quotes). */
  quotes?: string[];
  /** output paths of free text whose numbers must appear in the input. */
  freeText?: string[];
  /** numbers always allowed in free text (e.g. counts the feature itself computes and sent). */
  allowedNumbers?: number[];
}

export class GroundingError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'GroundingError'; }
}

type PathStep = { key: string; wildcard: boolean; index?: number };

function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  for (const part of path.split('.')) {
    const m = /^([^\[\]]*)((?:\[\d*\])*)$/.exec(part);
    if (!m) throw new Error(`bad path ${path}`);
    if (m[1]) steps.push({ key: m[1], wildcard: false });
    for (const br of m[2].match(/\[\d*\]/g) ?? []) {
      const inner = br.slice(1, -1);
      steps.push(inner === '' ? { key: '', wildcard: true } : { key: '', wildcard: false, index: Number(inner) });
    }
  }
  return steps;
}

/** Resolves a path (supports `a.b[].c`, `a[0]`) to the list of values found. */
export function resolvePath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const step of parsePath(path)) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (step.wildcard) { if (Array.isArray(node)) next.push(...node); }
      else if (step.index !== undefined) { if (Array.isArray(node) && node[step.index] !== undefined) next.push(node[step.index]); }
      else if (typeof node === 'object') { const v = (node as Record<string, unknown>)[step.key]; if (v !== undefined) next.push(v); }
    }
    current = next;
  }
  return current;
}

const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function collectInputText(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(normalizeDigits(value));
  else if (Array.isArray(value)) value.forEach((v) => collectInputText(v, out));
  else if (value && typeof value === 'object') Object.values(value as object).forEach((v) => collectInputText(v, out));
}

function collectInputNumbers(value: unknown, out: Set<string>): void {
  if (typeof value === 'number' && Number.isFinite(value)) out.add(String(value));
  else if (typeof value === 'string') for (const m of normalizeDigits(value).match(/\d+(?:[.,]\d+)?/g) ?? []) out.add(m.replace(',', '.'));
  else if (Array.isArray(value)) value.forEach((v) => collectInputNumbers(v, out));
  else if (value && typeof value === 'object') Object.values(value as object).forEach((v) => collectInputNumbers(v, out));
}

const norm = (s: string) => normalizeDigits(s).replace(/\s+/g, ' ').trim();

/** Throws GroundingError on the first violation. */
export function verifyGrounding(output: unknown, input: unknown, spec: GroundingSpec): void {
  for (const rule of spec.ids ?? []) {
    const allowed = new Set(resolvePath(input, rule.input).map((v) => String(v)));
    for (const v of resolvePath(output, rule.output)) {
      if (!allowed.has(String(v))) throw new GroundingError(`id not in input: ${rule.output}`);
    }
  }

  for (const path of spec.basedOn ?? []) {
    for (const arr of resolvePath(output, path)) {
      if (!Array.isArray(arr) || arr.length === 0) throw new GroundingError(`basedOn missing: ${path}`);
      for (const ref of arr) {
        if (typeof ref !== 'string' || !ref) throw new GroundingError('basedOn entry invalid');
        const found = resolvePath(input, ref);
        if (found.length === 0 || found.every(isEmptyValue)) throw new GroundingError(`basedOn does not exist in input: ${ref}`);
      }
    }
  }

  const texts: string[] = [];
  collectInputText(input, texts);
  const haystack = texts.join('\n');
  const haystackNorm = norm(haystack);
  for (const path of spec.quotes ?? []) {
    for (const q of resolvePath(output, path)) {
      if (typeof q !== 'string' || !q.trim()) throw new GroundingError(`empty quote: ${path}`);
      if (!haystackNorm.includes(norm(q))) throw new GroundingError(`quote not found in input: ${path}`);
    }
  }

  if (spec.freeText?.length) {
    const inputNumbers = new Set<string>();
    collectInputNumbers(input, inputNumbers);
    for (const n of spec.allowedNumbers ?? []) inputNumbers.add(String(n));
    for (const path of spec.freeText) {
      for (const t of resolvePath(output, path)) {
        if (typeof t !== 'string') continue;
        for (const m of normalizeDigits(t).match(/\d+(?:[.,]\d+)?/g) ?? []) {
          if (!inputNumbers.has(m.replace(',', '.'))) throw new GroundingError(`number not in input: ${path}`);
        }
      }
    }
  }
}
