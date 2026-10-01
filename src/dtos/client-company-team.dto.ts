import { z } from 'zod';

// Batch 6 — Client Company employee roster. Reuses the exact same
// company_team_members table/CompanyTeamMember model as the PROVIDER_COMPANY
// roster (src/dtos/company-team.dto.ts) — companyOwnerId is a plain User.id
// FK with no accountType constraint at the DB level, so this is schema-
// compatible with zero migration. memberType is never accepted from the
// client here (always forced to 'EMPLOYEE' by the controller) since
// 'PROVIDER' has no meaning for a client company's own staff roster.
const clientTeamMemberFieldsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(5).max(30).optional().nullable(),
  jobTitle: z.string().trim().min(2).max(120),
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']).optional(),
  avatarUrl: z.string().trim().url().max(2048).optional().nullable()
});

export const createClientTeamMemberSchema = clientTeamMemberFieldsSchema;

export const updateClientTeamMemberSchema = clientTeamMemberFieldsSchema.partial().refine(
  value => Object.keys(value).length > 0,
  { message: 'لا توجد بيانات للتحديث' }
);

export type CreateClientTeamMemberInput = z.infer<typeof createClientTeamMemberSchema>;
export type UpdateClientTeamMemberInput = z.infer<typeof updateClientTeamMemberSchema>;
