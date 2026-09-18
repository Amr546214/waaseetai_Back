import { z } from 'zod';

// Full set of roles that exist on User.roles[] / User.activeRole. ADMIN and
// SUPER_ADMIN are privileged/internal roles that must never be reachable
// through a self-service request — see SelfServiceUserRoleEnum below, which
// is what every public-facing role-selection endpoint must validate against.
export const UserRoleEnum = z.enum(['CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN']);

// The only roles a user may ever self-service add/switch to. ADMIN/SUPER_ADMIN
// are deliberately excluded: those are internal/operator roles provisioned
// out-of-band (e.g. directly in the database or an internal admin tool), never
// through a request a regular authenticated user can send.
export const SelfServiceUserRoleEnum = z.enum(['CLIENT', 'PROVIDER', 'AFFILIATE']);

export const AddAccountTypeSchema = z.object({
  targetRole: SelfServiceUserRoleEnum,
  profileMetadata: z.record(z.string(), z.any()).optional()
});

export type AddAccountTypeDto = z.infer<typeof AddAccountTypeSchema>;

export const SwitchActiveRoleSchema = z.object({
  targetRole: SelfServiceUserRoleEnum
});

export type SwitchActiveRoleDto = z.infer<typeof SwitchActiveRoleSchema>;
