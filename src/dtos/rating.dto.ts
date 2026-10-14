import { z } from 'zod';

/** The quick-pick tags each side may attach to a review (the same lists the rating pages show). Anything else is refused. */
export const CLIENT_RATING_TAGS = ['جودة عالية', 'التزام بالموعد', 'تواصل ممتاز', 'احترافية', 'مرونة في التعديلات', 'قيمة مقابل السعر'] as const;
export const PROVIDER_RATING_TAGS = ['توصيات واضحة', 'تعاون ممتاز', 'ردود سريعة', 'متطلبات منظمة', 'احترام المواعيد', 'قيمة عادلة للعمل'] as const;
export const ALL_RATING_TAGS: readonly string[] = [...CLIENT_RATING_TAGS, ...PROVIDER_RATING_TAGS];

export const createRatingSchema = z.object({
  // A whole number of stars: a half or fractional score is not a valid rating.
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().refine(t => ALL_RATING_TAGS.includes(t), 'وسم تقييم غير معروف')).max(6).optional()
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;
