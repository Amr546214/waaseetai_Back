import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE } from '../utils/client-payout-fields';

// POST /api/client/profile/setup — the four objects the wizard sends (details, identity, documents, agreements) plus the optional PayPal/bank
// object. Unknown keys are stripped. Every field keeps the tolerance the handler always had ('' / null = not provided) but now has a type and
// a length limit, and a missing object or a non-true agreement is a 400 instead of a TypeError/500.
const text = (max: number) => sanitizedText(z.string().trim().max(max, `الحد الأقصى ${max} حرفًا`)).nullable().optional();
// A KYC file travels as a base64 data URI or an already-stored reference; the real size/type checks are in assertKycFileValues.
const fileValue = z.string().max(15_000_000, 'الملف كبير جدًا').nullable().optional();
const agreed = (message: string) => z.literal(true, { message });

const detailsFields = {
	idNumber: z.string().trim().regex(/^[12]\d{9}$/, 'رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2').or(z.literal('')).nullable().optional(),
	dob: z.string().trim().refine(v => !Number.isNaN(Date.parse(v)) && new Date(v) <= new Date(), 'تاريخ الميلاد غير صحيح').or(z.literal('')).nullable().optional(),
	country: text(60),
	city: text(80),
	occupation: text(100),
	address: text(500),
	bio: text(1000),
	// a short list of interest labels; each is stored trimmed and tag-free
	interests: z.array(sanitizedText(z.string().trim().min(1).max(40, 'الاهتمام طويل جدًا'))).max(20, 'الحد الأقصى 20 اهتمامًا').nullable().optional()
};

export const clientSetupSchema = z.object({
	details: z.object(detailsFields, { message: 'بيانات طالب الخدمة مطلوبة' }),
	identity: z.object({ frontId: fileValue, backId: fileValue }, { message: 'بيانات الهوية مطلوبة' }),
	documents: z.object({ supportingDocs: fileValue, notes: text(1000) }, { message: 'بيانات المستندات مطلوبة' }),
	agreements: z.object({
		accurate: agreed('يجب الإقرار بصحة البيانات'),
		terms: agreed('يجب الموافقة على الشروط والأحكام'),
		privacy: agreed('يجب الموافقة على سياسة الخصوصية')
	}, { message: 'الإقرارات مطلوبة' }),
	// PayPal is the only financial method: a bank / IBAN / account holder / wallet value is a 400 (never stored); an empty one is ignored.
	bank: z.object({
		paymentType: z.string().trim().max(20).nullable().optional(),
		paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional()
	}).catchall(z.unknown()).superRefine((bank, ctx) => {
		for (const key of nonPaypalPayoutKeys(bank)) ctx.addIssue({ code: 'custom', path: [key], message: PAYPAL_ONLY_MESSAGE });
		const type = String(bank.paymentType ?? '').trim().toLowerCase();
		if (type && type !== 'paypal') ctx.addIssue({ code: 'custom', path: ['paymentType'], message: PAYPAL_ONLY_MESSAGE });
	}).optional(),
	// legacy top-level field, still read by the handler
	paypalPayoutEmail: z.string().trim().max(254, 'بريد PayPal طويل جدًا').nullable().optional()
});

export type ClientSetupInput = z.infer<typeof clientSetupSchema>;

// PUT /api/client/profile/setup/step/:step — each wizard step is stored on its own the moment the user moves on (1 details, 2 identity
// documents, 3 PayPal, 4 optional documents). '' / null = "not provided": a stored value is kept. The final POST /setup still records the agreements.
export const clientSetupStepSchemas = {
	1: z.object({ details: z.object(detailsFields, { message: 'بيانات طالب الخدمة مطلوبة' }) }),
	2: z.object({ identity: z.object({ frontId: fileValue, backId: fileValue }, { message: 'بيانات الهوية مطلوبة' }) }),
	3: z.object({ paypalPayoutEmail: z.string({ message: 'بريد PayPal مطلوب' }).trim().min(1, 'بريد PayPal مطلوب').max(254, 'بريد PayPal طويل جدًا') }),
	4: z.object({ documents: z.object({ supportingDocs: fileValue, notes: text(1000) }, { message: 'بيانات المستندات مطلوبة' }) }),
} as const;
export type ClientSetupStep = keyof typeof clientSetupStepSchemas;
