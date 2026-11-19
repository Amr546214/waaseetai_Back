// The signed-out assistant: a visitor asks about the platform itself (who Waseet is, what it does, its goal, what sets it apart, how to start) and gets an
// answer grounded in the public facts kept in the AI service. A technical / dashboard-depth / account question is NOT answered: the visitor is told to sign in
// (a fixed message, never model text) and the client shows a sign-in button. No account data is read or sent, and the model's text is shown only for PUBLIC / OFF_TOPIC.
import { z } from 'zod';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/app-error';
import { waseetAiClient } from './waseet-ai/waseet-ai.client';

export const publicAskSchema = z.object({
	question: z.string().trim().min(1, 'اكتب سؤالك').max(400, 'السؤال طويل؛ اختصره في 400 حرف'),
	language: z.enum(['ar', 'en']).default('ar'),
	history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(500) })).max(4).default([])
}).strip();
export type PublicAsk = z.infer<typeof publicAskSchema>;

export type PublicAnswerKind = 'ANSWER' | 'LOGIN_REQUIRED' | 'NOT_COVERED' | 'OFF_TOPIC' | 'BUSY';
export interface PublicAnswer { kind: PublicAnswerKind; answer: string; loginRequired: boolean }

const MESSAGES = {
	ar: {
		LOGIN_REQUIRED: 'هذا السؤال عن تفاصيل تقنية أو داخل المنصة، ولا أستطيع الإجابة عنه قبل تسجيل الدخول. سجّل دخولك وسأساعدك بكل سرور.',
		NOT_COVERED: 'لا أملك معلومة مؤكدة عن هذا الموضوع هنا. يمكنك التواصل مع فريق وسيط من صفحة «اتصل بنا»، وسيردون عليك خلال 24 ساعة.',
		BUSY: 'عدد الأسئلة كبير الآن، حاول مرة أخرى بعد قليل.'
	},
	en: {
		LOGIN_REQUIRED: 'This question is about technical or in-platform details, and I can only answer it after you sign in. Sign in and I will gladly help.',
		NOT_COVERED: "I don't have confirmed information about that here. You can reach the Waseet team from the 'Contact us' page; they reply within 24 hours.",
		BUSY: 'There are a lot of questions right now, please try again shortly.'
	}
} as const;

/** a hard daily ceiling on model calls for visitors (a cost guard on top of the per-address rate limit); resets at 00:00 UTC */
let dayKey = ''; let dayCount = 0;
const dailyCap = () => { const v = Number(process.env.PUBLIC_ASSISTANT_DAILY_CAP); return Number.isFinite(v) && v > 0 ? v : 2000; };
export const resetPublicAssistantCounter = () => { dayKey = ''; dayCount = 0; };
function takeDailySlot(now: Date): boolean {
	const key = now.toISOString().slice(0, 10);
	if (key !== dayKey) { dayKey = key; dayCount = 0; }
	if (dayCount >= dailyCap()) return false;
	dayCount++;
	return true;
}

type Client = { publicAsk: typeof waseetAiClient.publicAsk };

export async function askPublicAssistant(input: unknown, client: Client = waseetAiClient, now: Date = new Date()): Promise<PublicAnswer> {
	const parsed = publicAskSchema.safeParse(input ?? {});
	if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'سؤال غير صالح', 400);
	const { question, language, history } = parsed.data;
	const text = MESSAGES[language];
	if (!takeDailySlot(now)) return { kind: 'BUSY', answer: text.BUSY, loginRequired: false };
	const actor = { userId: 'public-visitor', role: 'system' as const };
	let result;
	try {
		result = await client.publicAsk({ question, language, history, actor }, { actor, timeoutMs: 30_000 });
	} catch (error: any) {
		logger.warn(`[public-assistant] AI call failed: ${error?.code || error?.name || 'ERROR'}`);
		return { kind: 'BUSY', answer: text.BUSY, loginRequired: false };
	}
	switch (result.scope) {
		case 'PUBLIC': return result.answer.trim() ? { kind: 'ANSWER', answer: result.answer.trim(), loginRequired: false } : { kind: 'NOT_COVERED', answer: text.NOT_COVERED, loginRequired: false };
		case 'OFF_TOPIC': return { kind: 'OFF_TOPIC', answer: result.answer.trim() || text.NOT_COVERED, loginRequired: false };
		case 'ACCOUNT_REQUIRED': return { kind: 'LOGIN_REQUIRED', answer: text.LOGIN_REQUIRED, loginRequired: true };
		default: return { kind: 'NOT_COVERED', answer: text.NOT_COVERED, loginRequired: false };
	}
}
