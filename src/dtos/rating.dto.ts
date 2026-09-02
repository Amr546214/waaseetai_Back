import { z } from 'zod';

export const createRatingSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().trim().max(2000).optional()
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;
