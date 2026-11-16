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
// The add-account wizard (a client adding a provider account): the skills catalog of the chosen specialty is what the AI may choose from.
export const catalogSkillsSuggestSchema = z.object({
  mainSpecialty: z.string().trim().min(1).max(120),
  availableSkills: z.array(z.string().trim().min(1).max(120)).min(1).max(250),
  existingSkills: z.array(z.string().trim().min(1).max(40)).max(30).optional()
}).strict();
export type CatalogSkillsSuggestDto = z.infer<typeof catalogSkillsSuggestSchema>;
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
  // the kind the user CHOSE (NATIONAL_ID / PASSPORT / RESIDENCE_PERMIT / DRIVING_LICENCE) and the document country: the AI check flags an upload of another kind
  document: z.object({ country: z.string().trim().min(2).max(16).optional(), type: z.string().trim().min(1).max(60).optional() }).optional(),
  declared: z.object({
    fullName: z.string().trim().max(200).optional(),
    birthDate: z.string().trim().max(40).optional(),
    nationalId: z.string().trim().max(50).optional(),
  }).optional(),
}).strict();
export type IdentityDocumentInspectDto = z.infer<typeof identityDocumentInspectSchema>;

// The ordinary setup save can connect existing taxonomy names, never create them.
export const setupSkillsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
