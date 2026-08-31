import { z } from 'zod';

export const UserRoleEnum = z.enum(['CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN']);

export const AddAccountTypeSchema = z.object({
  targetRole: UserRoleEnum,
  profileMetadata: z.record(z.string(), z.any()).optional()
});

export type AddAccountTypeDto = z.infer<typeof AddAccountTypeSchema>;

export const SwitchActiveRoleSchema = z.object({
  targetRole: UserRoleEnum
});

export type SwitchActiveRoleDto = z.infer<typeof SwitchActiveRoleSchema>;
