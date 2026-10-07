import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';

// POST /api/client/profile/setup — the four objects the wizard sends (details, identity, documents, agreements) plus the optional PayPal/bank
// object. Unknown keys are stripped. Every field keeps the tolerance the handler always had ('' / null = not provided) but now has a type and
// a length limit, and a missing object or a non-true agreement is a 400 instead of a TypeError/500.
const text = (max: number) => sanitizedText(z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`)).nullable().optional();
// A KYC file travels as a base64 data URI or an already-stored reference; the real size/type checks are in assertKycFileValues.
const fileValue = z.string().max(15_000_000, 'الملف كبير جدًا').nullable().optional();
const agreed = (message: string) => z.literal(true, { message });

export const clientSetupSchema = z.object({
	details: z.object({
		idNumber: z.string().trim().regex(/^[12]\d{9}$/, 'رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2').or(z.literal('')).nullable().optional(),
		dob: z.string().trim().refine(v => !Number.isNaN(Date.parse(v)) && new Date(v) <= new Date(), 'تاريخ الميلاد غير صحيح').or(z.literal('')).nullable().optional(),
		country: text(60),
		city: text(80),
		occupation: text(100),
		address: text(500)
	}, { message: 'بيانات طالب الخدمة مطلوبة' }),
	identity: z.object({ frontId: fileValue, backId: fileValue }, { message: 'بيانات الهوية مطلوبة' }),
	documents: z.object({ supportingDocs: fileValue, notes: text(1000) }, { message: 'بيانات المستندات مطلوبة' }),
	agreements: z.object({
		accurate: agreed('يجب الإقرار بصحة البيانات'),
		terms: agreed('يجب الموافقة على الشروط والأحكام'),
		privacy: agreed('يجب الموافقة على سياسة الخصوصية')
	}, { message: 'الإقرارات مطلوبة' }),
	bank: z.object({
		paymentType: z.string().trim().max(20).nullable().optional(),
		paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional(),
		bankName: text(100),
		accountHolder: text(100),
		iban: z.string().trim().max(40, 'الآيبان طويل جدًا').nullable().optional()
	}).optional(),
	// legacy top-level field, still read by the handler
	paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional()
});

export type ClientSetupInput = z.infer<typeof clientSetupSchema>;
