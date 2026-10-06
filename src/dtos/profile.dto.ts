import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';

export const updateProfileSchema = z.object({
	// Basic User fields
	firstName: sanitizedText(z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل')).optional().nullable(),
	lastName: sanitizedText(z.string().min(2, 'الاسم الأخير يجب أن يكون حرفين على الأقل')).optional().nullable(),
	phoneNumber: z.string().optional().nullable(),
	avatarUrl: z.string().optional().nullable().or(z.literal('')),

	// Client Profile fields
	companyName: z.string().optional().nullable().or(z.literal('')),
	companySize: z.string().optional().nullable().or(z.literal('')),
	industry: z.string().optional().nullable().or(z.literal('')),
	website: z.string().url('رابط الموقع غير صحيح').or(z.literal('')).nullable().optional(),
	bio: sanitizedText(z.string().max(1000, 'النبذة يجب أن لا تتجاوز 1000 حرف')).optional().nullable().or(z.literal('')),

	// Provider Profile fields
	skills: z.array(z.string()).optional().nullable(),
	hourlyRate: z.number().positive('سعر الساعة يجب أن يكون رقماً موجباً').optional().nullable(),
	yearsOfExperience: z.number().positive().optional().nullable(),
	headline: z.string().optional().nullable(),
	location: z.string().optional().nullable(),
	city: z.string().optional().nullable(),
	country: z.string().optional().nullable(),
	githubUrl: z.string().url('الرابط غير صحيح').optional().nullable().or(z.literal('')),
	linkedinUrl: z.string().url('الرابط غير صحيح').optional().nullable().or(z.literal('')),
	websiteUrl: z.string().url('الرابط غير صحيح').optional().nullable().or(z.literal('')),

	// Payout P2-A: the provider's own confirmed PayPal payout destination —
	// never auto-populated from the account's login email (a separate,
	// deliberate owner decision — see ProviderProfile.paypalPayoutEmail's own
	// schema comment). Trimmed and lowercased before the email-format check,
	// matching how PayPal itself treats recipient addresses case-insensitively
	// and guarding against stray whitespace from copy/paste. An empty string
	// is accepted (consistent with githubUrl/linkedinUrl/websiteUrl above) and
	// is treated as "no destination configured" everywhere this field is later
	// read (a falsy check), exactly like those other optional fields already
	// behave when cleared.
	paypalPayoutEmail: z.string().trim().toLowerCase().email('بريد PayPal غير صحيح').optional().nullable().or(z.literal('')),
});

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;


// Shared by the CLIENT PayPal paths (POST /client/profile/setup and
// PUT /profiles/update/banking): a required, trimmed, lower-cased email.
export const paypalPayoutEmailRequiredSchema = z.string().trim().toLowerCase().email('بريد PayPal غير صحيح');

/** Returns the normalized email, or null when the value is not a valid email. */
export function parsePaypalPayoutEmail(value: unknown): string | null {
	const r = paypalPayoutEmailRequiredSchema.safeParse(value);
	return r.success ? r.data : null;
}
