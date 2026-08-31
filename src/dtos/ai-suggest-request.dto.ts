import { z } from 'zod';

export const aiSuggestRequestSchema = z.object({
  projectId: z.string().min(1, 'معرف المشروع (projectId) مطلوب'),
  currentTitle: z.string().optional(),
  currentMessage: z.string().optional(),
  advantages: z.array(z.string()).optional().default([])
});

export type AiSuggestRequestDto = z.infer<typeof aiSuggestRequestSchema>;
