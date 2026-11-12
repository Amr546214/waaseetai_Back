import { z } from 'zod';

// Only unsaved setup context; stored fields take precedence. Identity is
// exclusively req.user.id. Unknown fields (including userId) are rejected.
const draftContext = {
  jobTitle: z.string().trim().max(120).optional(),
  mainSpecialty: z.string().trim().max(120).optional(),
  subSpecialties: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  experienceRange: z.enum(['أقل من سنة', '1 الى 3 سنوات', '3 الى 5 سنوات', '5 الى 10 سنوات', 'أكثر من 10 سنوات']).optional(),
  existingSkills: z.array(z.string().trim().min(1).max(40)).max(30).optional()
};
export const providerBioSuggestSchema = z.object(draftContext).strict();
export const providerSkillsSuggestSchema = z.object(draftContext).strict();
export type ProviderBioSuggestDto = z.infer<typeof providerBioSuggestSchema>;
export type ProviderSkillsSuggestDto = z.infer<typeof providerSkillsSuggestSchema>;

export const providerBioEnhanceSchema = z.object({
  bio: z.string().trim().min(10).max(500),
  jobTitle: z.string().trim().max(120).optional(),
  mainSpecialty: z.string().trim().max(120).optional(),
  subSpecialties: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  existingSkills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
}).strict();
export type ProviderBioEnhanceDto = z.infer<typeof providerBioEnhanceSchema>;

export const identityDocumentInspectSchema = z.object({
  side: z.enum(['FRONT', 'BACK']),
  image: z.string().trim().min(20).max(10_500_000),
  imageMimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']).optional(),
  declared: z.object({
    fullName: z.string().trim().max(200).optional(),
    birthDate: z.string().trim().max(40).optional(),
    nationalId: z.string().trim().max(50).optional(),
  }).optional(),
}).strict();
export type IdentityDocumentInspectDto = z.infer<typeof identityDocumentInspectSchema>;

// The ordinary setup save can connect existing taxonomy names, never create them.
export const setupSkillsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
