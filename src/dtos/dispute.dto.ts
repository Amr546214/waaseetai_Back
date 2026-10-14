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

export const assignDisputeSchema = z.object({ assigneeId: z.string().trim().min(1).max(64) });
export const disputeNoteSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export const disputeStatusSchema = z.object({ status: z.enum(['OPEN', 'UNDER_REVIEW']) });

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
