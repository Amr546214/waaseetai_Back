import { z } from 'zod';

export const createDisputeSchema = z.object({
  reason: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(10000),
  evidence: z.array(z.string().url()).max(10).optional().default([])
});

export const resolveDisputeSchema = z.object({
  action: z.enum(['resolve', 'reject']),
  resolution: z.string().trim().min(2).max(120),
  resolutionNote: z.string().trim().min(2).max(10000).optional()
});

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
