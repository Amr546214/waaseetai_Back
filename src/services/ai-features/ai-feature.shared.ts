import { z } from 'zod';
import { resolvePath } from '../llm/llm.truth';

// Shared building blocks for in-house AI features (LlmClient based). Nothing here talks to a model.

export const basedOnSchema = z.array(z.string().min(1).max(120)).min(1).max(6);

export const NO_DATA = 'غير متوفر';

export const GROUNDING_RULES_AR = [
  'اعتمد فقط على الحقول الموجودة في المدخلات (JSON). لا تستخدم أي معلومة من خارجها.',
  'لا تخترع أرقاماً أو أسماء أو تقنيات أو متطلبات أو مهارات غير مذكورة في المدخلات.',
  `إذا كان حقل فارغاً أو null فاكتب "${NO_DATA}" ولا تخمّن قيمته.`,
  'لكل نقطة أو ملاحظة أرفق basedOn: قائمة مسارات الحقول في المدخلات التي بنيت عليها (مثل project.requiredSkills)، ولا تذكر إلا مسارات فيها بيانات فعلية.',
  'اكتب بالعربية الفصحى المهنية المختصرة، نصاً عادياً بلا ماركداون. لا تذكر اسم أي نموذج أو شركة ذكاء اصطناعي.',
  'أعد JSON فقط مطابقاً للشكل المطلوب.',
].join('\n');

/** Field paths (relative to the payload root) that hold real data, computed server-side for traceability. */
export function inputsUsed(payload: unknown, paths: string[]): string[] {
  return paths.filter((p) => {
    const values = resolvePath(payload, p);
    return values.some((v) => !(v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)));
  });
}

/** Integers 0..N, where N is the largest array length in the payload: counts a feature may legitimately state. */
export function countNumbers(payload: unknown): number[] {
  let max = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { max = Math.max(max, v.length); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v as object).forEach(walk);
  };
  walk(payload);
  return Array.from({ length: max + 1 }, (_, i) => i);
}
