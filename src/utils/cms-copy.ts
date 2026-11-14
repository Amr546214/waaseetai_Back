import { z } from 'zod';
/** Plain text only: never HTML, selectors, links, scripts or styles. Keys identify a text node in the real page. */
export const cmsCopySchema = z.object({
  version: z.literal(1),
  edits: z.array(z.object({
    key: z.string().min(1).max(240).regex(/^[a-zA-Z0-9:._/-]+$/),
    original: z.string().min(1).max(8000),
    value: z.string().max(8000),
  }).strict()).max(1000),
}).strict().refine(c=>new Set(c.edits.map(e=>e.key)).size===c.edits.length,'مفتاح نص مكرر').refine(c=>JSON.stringify(c).length<=250000,'حجم النصوص كبير جدًا');
export type CmsCopy = z.infer<typeof cmsCopySchema>;
