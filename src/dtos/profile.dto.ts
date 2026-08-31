import { z } from 'zod';export const updateProfileSchema = z.object({
	// Basic User fields
	firstName: z.string().min(2, 'الاسم الأول يجب أن يكون حرفين على الأقل').optional().nullable(),
	lastName: z.string().min(2, 'الاسم الأخير يجب أن يكون حرفين على الأقل').optional().nullable(),
	phoneNumber: z.string().optional().nullable(),
	avatarUrl: z.string().optional().nullable().or(z.literal('')),

	// Client Profile fields
	companyName: z.string().optional().nullable().or(z.literal('')),
	companySize: z.string().optional().nullable().or(z.literal('')),
	industry: z.string().optional().nullable().or(z.literal('')),
	website: z.string().url('رابط الموقع غير صحيح').or(z.literal('')).nullable().optional(),
	bio: z.string().max(1000, 'النبذة يجب أن لا تتجاوز 1000 حرف').optional().nullable().or(z.literal('')),

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
});

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
