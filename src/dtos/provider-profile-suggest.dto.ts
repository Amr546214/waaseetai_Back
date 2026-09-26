import { z } from 'zod';

// Only unsaved setup context; stored fields take precedence. Identity is
// exclusively req.user.id. Unknown fields (including userId) are rejected.
const draftContext = {
  jobTitle: z.string().trim().max(120).optional(),
  mainSpecialty: z.string().trim().max(120).optional(),
  experienceRange: z.enum(['أقل من سنة', '1 الى 3 سنوات', '3 الى 5 سنوات', '5 الى 10 سنوات', 'أكثر من 10 سنوات']).optional(),
  existingSkills: z.array(z.string().trim().min(1).max(40)).max(30).optional()
};
export const providerBioSuggestSchema = z.object(draftContext).strict();
export const providerSkillsSuggestSchema = z.object(draftContext).strict();
export type ProviderBioSuggestDto = z.infer<typeof providerBioSuggestSchema>;
export type ProviderSkillsSuggestDto = z.infer<typeof providerSkillsSuggestSchema>;

// The ordinary setup save can connect existing taxonomy names, never create them.
export const setupSkillsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
