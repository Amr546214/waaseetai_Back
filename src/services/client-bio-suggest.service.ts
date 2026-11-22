import { z } from 'zod';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';

export const clientBioSuggestSchema = z.object({
	bio: z.string().max(2000).optional(),
	occupation: z.string().max(200).optional(),
	interests: z.array(z.string().max(80)).max(20).optional(),
}).strict();
export type ClientBioSuggestInput = z.infer<typeof clientBioSuggestSchema>;

const clean = (v?: string | null) => (v ?? '').replace(/\s+/g, ' ').trim();

/**
 * «ساعدني أكتب نبذة»: the service seeker's bio drafted by the AI from what they typed in the form (falling back to what is stored), or their own draft polished.
 * Advisory: the text only goes back to the form; nothing is saved here. Individual and company are told apart by the account, never by the request.
 */
export const clientBioSuggestService = {
	async suggest(userId: string, input: ClientBioSuggestInput, ai: Pick<typeof waseetAiClient, 'suggestClientBio'> = waseetAiClient): Promise<{ suggestedBio: string }> {
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { accountType: true, city: true, clientProfile: { select: { industry: true, bio: true, interests: true, companyName: true, city: true } } },
		});
		if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		const p = user.clientProfile;
		const company = user.accountType === 'CLIENT_COMPANY';
		const interests = (input.interests ?? p?.interests ?? []).map(clean).filter(Boolean).slice(0, 20);
		const body = {
			clientId: userId,
			audience: company ? 'company' : 'individual',
			currentBio: clean(input.bio ?? p?.bio) || undefined,
			occupation: company ? undefined : clean(input.occupation ?? p?.industry) || undefined,
			companyName: company ? clean(p?.companyName) || undefined : undefined,
			industry: company ? clean(input.occupation ?? p?.industry) || undefined : undefined,
			interests,
			city: clean(p?.city ?? user.city) || undefined,
			maxLength: 500,
		};
		const hasData = !!(body.currentBio && body.currentBio.length >= 10) || !!(body.occupation || body.companyName || body.industry || interests.length);
		if (!hasData) throw new AppError('أضف مهنتك أو اهتماماتك، أو اكتب سطرًا مبدئيًا في النبذة، ثم اطلب المساعدة.', 400);
		try {
			const result = await ai.suggestClientBio(body);
			const suggestedBio = typeof result?.suggestedBio === 'string' ? result.suggestedBio.trim().slice(0, 500) : '';
			if (!suggestedBio) throw new Error('EMPTY_BIO');
			return { suggestedBio };
		} catch (error: any) {
			logger.warn(`[ClientBioSuggest] failed: ${error?.code || error?.name || 'ERROR'}`);
			throw new AppError('تعذر إنشاء اقتراح النبذة بالذكاء الاصطناعي حالياً، يرجى المحاولة لاحقاً.', 503);
		}
	},
};
