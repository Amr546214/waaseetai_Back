import { z } from 'zod';

export const createRatingSchema = z.object({
  // A whole number of stars: a half or fractional score is not a valid rating.
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional()
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;
