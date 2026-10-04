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

// The wizard's optional answers. Only the shape/length is checked here (a wrong type or an oversize
// value is a 400 with the field named, instead of reaching Prisma); unknown keys are still accepted.
const metaText = (label: string, max: number) =>
  z.string().max(max, `${label} يجب ألا يتجاوز ${max} حرفًا`);
const ProfileMetadataSchema = z.object({
  specMain: metaText('التخصص', 100).optional(),
  specExp: metaText('سنوات الخبرة', 50).optional(),
  portfolioBio: metaText('النبذة المهنية', 1000).optional(),
  chType: metaText('قناة التسويق', 100).optional(),
  chReach: metaText('عدد المتابعين', 100).optional(),
  coName: metaText('اسم الشركة', 150).optional(),
  coCrn: metaText('رقم السجل التجاري', 50).optional(),
  coRole: metaText('المنصب', 100).optional(),
  skills: z.array(z.string().max(60, 'المهارة يجب ألا تتجاوز 60 حرفًا')).max(50, 'عدد المهارات كبير جدًا').optional()
}).passthrough();

export const AddAccountTypeSchema = z.object({
  targetRole: SelfServiceUserRoleEnum,
  profileMetadata: ProfileMetadataSchema.optional()
});

export type AddAccountTypeDto = z.infer<typeof AddAccountTypeSchema>;

export const SwitchActiveRoleSchema = z.object({
  targetRole: SelfServiceUserRoleEnum
});

export type SwitchActiveRoleDto = z.infer<typeof SwitchActiveRoleSchema>;
