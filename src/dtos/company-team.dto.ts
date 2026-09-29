import { z } from 'zod';

const teamMemberFieldsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(5).max(30).optional().nullable(),
  jobTitle: z.string().trim().min(2).max(120),
  memberType: z.enum(['PROVIDER', 'EMPLOYEE']),
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']).optional(),
  avatarUrl: z.string().trim().url().max(2048).optional().nullable()
});

export const createTeamMemberSchema = teamMemberFieldsSchema;

export const updateTeamMemberSchema = teamMemberFieldsSchema.partial().refine(
  value => Object.keys(value).length > 0,
  { message: 'لا توجد بيانات للتحديث' }
);

export type CreateTeamMemberInput = z.infer<typeof createTeamMemberSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
