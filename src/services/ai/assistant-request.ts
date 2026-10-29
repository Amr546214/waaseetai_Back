import { z } from 'zod';
import { scrubFreeText } from '../llm/llm.payload';
import type { HelpChatRequest } from './waseet-ai/waseet-ai.types';

export const assistantOptionsSchema = z.object({
  skin: z.enum(['scout', 'classic']).default('scout'),
  dialect: z.enum(['egyptian', 'saudi', 'gulf', 'msa', 'english']).optional(),
  language: z.enum(['ar', 'ar-EG', 'ar-SA', 'en', 'en-US']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  profile: z.enum(['fast', 'balanced', 'deep', 'auto']).optional(),
  model: z.string().regex(/^gemini-[a-zA-Z0-9.-]{1,80}$/).optional(),
  mode: z.enum(['policy', 'general']).optional(),
  webSearch: z.boolean().optional(),
  pageContext: z.object({ path: z.string().regex(/^\/(?!\/)[a-zA-Z0-9_\-/]{0,300}$/), projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional() }).strip().optional(),
}).strip();

/** Raw page data and identity never come from the browser. Owned records are loaded again server-side. */
export async function resolveAssistantOptions(raw: unknown, userId: string, role: string): Promise<Partial<HelpChatRequest>> {
  const parsed = assistantOptionsSchema.parse(raw || {});
  const { pageContext, ...settings } = parsed;
  const result: Partial<HelpChatRequest> = { ...settings, ...(settings.language ? { language: settings.language.startsWith('en') ? 'en' : settings.language === 'ar-EG' ? 'ar-EG' : 'ar' } : {}) } as Partial<HelpChatRequest>;
  if (!pageContext) return result;
  result.pageContext = { path: pageContext.path, role };
  if (!pageContext.projectId) return result;
  const { prisma } = await import('../../config/db.js');
  const row = await prisma.project.findFirst({
    where: { id: pageContext.projectId, ...(role === 'admin' ? {} : { OR: [{ clientId: userId }, { providerId: userId }, { contract: { OR: [{ clientId: userId }, { providerId: userId }] } }] }) },
    select: { id: true, title: true, description: true, requirements: true, status: true },
  });

  if (!row) throw Object.assign(new Error('PROJECT_CONTEXT_DENIED'), { code: 'FORBIDDEN' });
  result.pageContext.project = { id: row.id, title: scrubFreeText(row.title).slice(0, 200), description: scrubFreeText(row.description).slice(0, 4000),
    requirements: row.requirements.slice(0, 30).map(r => scrubFreeText(r).slice(0, 500)), status: row.status };
  return result;
}

function normalizedIntentText(text: string): string {
  return text.normalize('NFKC').replace(/[\u064B-\u065F\u0670ـ]/g, '').replace(/[أإآ]/g, 'ا').trim();
}

/** Ordinary questions use general knowledge; platform policy topics require approved evidence. */
export function inferAssistantMode(question: string): 'general' | 'policy' {
  const value = normalizedIntentText(question);
  const platformContext = /وسيط|\b(?:waseet|waaseet|platform)\b|المنص[ةه]|حسابي|حسابنا|\bmy account\b/i.test(value);
  const generalTopic = /رسوم(?:ات)?\s+(?:ال)?(?:متحرك[ةه]|بياني[ةه])|ضمان\s+الجود[ةه]|\b(?:quality assurance|animation|animated cartoons|charts?|graphs?)\b/i.test(value);
  if (generalTopic && !platformContext) return 'general';
  return /رسوم|عمول[ةه]|عمولات|سياس[ةه]|سياسات|ضمان|سحب|دفع|مدفوعات|استرداد|استرجاع|نزاع|صلاحيات|صلاحي[ةه]|افراج|تحكيم|\b(?:fees?|commissions?|refunds?|withdraw(?:al|als|ing)?|polic(?:y|ies)|escrow|disputes?|payments?|payouts?|permissions?)\b/i.test(value)
    ? 'policy' : 'general';
}

/** A browser preference cannot move a policy question into an ungrounded answer mode. */
export function resolveAssistantMode(question: string, requested?: HelpChatRequest['mode']): 'general' | 'policy' {
  const inferred = inferAssistantMode(question);
  return inferred === 'policy' ? 'policy' : requested ?? inferred;
}

const GREETING_PHRASE = '(?:عامل\\s*ايه(?:\\s*يا\\s*(?:غالي|باشا|هندسة|كبير|صاحبي|فنان|نديم|بيبو|كابتن|برنس|عمنا|سيدي|زعيم|دكتور|حبيبي|محترم))?|ازيك(?:\\s*يا\\s*(?:غالي|باشا|هندسة|كبير|صاحبي|فنان|نديم|بيبو|كابتن|برنس|عمنا|سيدي|زعيم|دكتور|حبيبي|محترم))?|ازي\\s*حضرتك|اخبارك|شخبارك|كيف\\s*حالك|كيفك|شلونك|كيف\\s*الصحه|صباح\\s*(?:الخير|الورد|النور|الفل|الجمال)|مساء\\s*(?:الخير|الورد|النور|الفل|الجمال)|(?:السلام|سلام)\\s*عليكم(?:\\s*ورحمة\\s*الله(?:\\s*وبركاته)?)?|سلامات|مرحبا|هلا|هاي|اهلا(?:\\s*وسهلا)?|(?:شكرا|مشكور|تسلم)(?:\\s*يا\\s*(?:غالي|باشا|هندسة|كبير|صاحبي|فنان|نديم|بيبو|كابتن|برنس|عمنا|سيدي|زعيم|دكتور|حبيبي|محترم))?|يعطيك\\s*العافية|يسطا|يا\\s*(?:هندسة|كابتن|عمنا|عم|سيدي|برنس|زعيم|دكتور|حبيبي|حبيب\\s*قلبي|طيب|محترم|ذوق|زوق|بطل|اسط[ىي]|اسطا|سط[ةه]|باشا|كبير|غالي|صاحبي|فنان|نديم|بيبو)|hello|hi|hey|good\\s*(?:morning|evening)|thanks|thank\\s*you)';
const IDENTITY_PHRASE = '(?:(?:(?:هو|هي)\\s+)?(?:انت|انتا|انتي)\\s*(?:مين|منو|ايه|اي)|(?:مين|من|منو)\\s*(?:انت|انتا|انتي|حضرتك|معايا)|(?:عرفني|عرف)\\s*بنفسك|(?:وش|ايش|شنو|ما(?:\\s+هو)?)\\s*اسمك|اسمك\\s*(?:ايه|اي|ايش|شنو|منو)|(?:ايه|اي)\\s*اسمك|بتعمل\\s*(?:ايه|اي)|وظيفتك\\s*(?:ايه|اي)|دورك\\s*(?:ايه|اي)|مين\\s*معايا|من\\s*تكون|who\\s+are\\s+you|what(?:\\s+is|[’\\x27]s)\\s+your\\s+name)(?:\\s*(?:اصلا|بالظبط|بالضبط|يا\\s*(?:غالي|باشا|نديم|بيبو|كبير|صاحبي)))?';
const INTENT_SEPARATOR = '[؟?!.،,؛;…\\s]*';
const GREETING_PATTERN = new RegExp(`^(?:(?:${GREETING_PHRASE}|${IDENTITY_PHRASE})${INTENT_SEPARATOR})+$`, 'i');

/** Match only a complete pleasantry/identity request; a following question always reaches AI. */
export function isGreetingIntent(text: string): boolean {
  return GREETING_PATTERN.test(normalizedIntentText(text));
}

export const EXAM_INTEGRITY_REFUSAL_AR =
  'عذراً، لا يمكنني الإجابة على أسئلة الاختبارات التقنية أو التقييمات المهنية حفاظاً على نزاهة وعدالة التقييم في منصة وسيط. يمكنك إتمام الاختبار بنفسك أولاً ثم الاستفسار عن أي مفهوم تقني للتعلم لاحقاً.';

export function isExamSolvingIntent(question: string, pagePath?: string): boolean {
  const norm = normalizedIntentText(question);
  if (pagePath && /setup-test|assessment|quiz|exam/i.test(pagePath)) {
    return true;
  }
  return /(?:حل\s+(?:لي\s+)?(?:هذا\s+)?السؤال|ما\s+هي\s+الاجاب[ةه]\s+الصحيح[ةه]|اختر\s+الاجاب[ةه]\s+الصحيح[ةه]|سؤال\s+في\s+اختبار\s+التخصص|امتحان\s+القبول|اختبار\s+الاعتماد)/i.test(norm);
}

export function assistantGreetingResponse(options: Partial<HelpChatRequest>): string {
  const dialect = options.dialect ?? (options.language === 'en' ? 'english' : undefined);
  return greetingForDialect(dialect, options.skin) || greetingResponseForSkin(options.skin);
}

export function greetingForDialect(dialect?: string, skin?: string): string | undefined {
  const isScout = skin === 'scout';
  if (dialect === 'egyptian') {
    return isScout
      ? 'أهلًا! أنا نديم، دليلك في وسيط. أقدر أساعدك تفهم المنصة، تجهّز مشروعك أو عرضك، وتراجع التفاصيل المتاحة ليك. محتاج إيه؟'
      : 'أهلًا! أنا بيبو، مساعدك في وسيط. أقدر أساعدك تفهم المنصة، تجهّز مشروعك أو عرضك، وتراجع التفاصيل المتاحة ليك. محتاج إيه؟';
  }
  if (dialect === 'saudi' || dialect === 'gulf') {
    return isScout
      ? 'هلا! أنا نديم، دليلك في وسيط. أساعدك تفهم المنصة وتجهّز مشروعك أو عرضك وتراجع التفاصيل المتاحة لك. وش تحتاج؟'
      : 'هلا! أنا بيبو، مساعدك في وسيط. أساعدك تفهم المنصة وتجهّز مشروعك أو عرضك وتراجع التفاصيل المتاحة لك. وش تحتاج؟';
  }
  if (dialect === 'english') {
    return isScout
      ? 'Hi! I’m Nadeem, your Waseet guide. I can explain the platform and help you prepare projects, proposals, and review available information. How can I help?'
      : 'Hi! I’m Bebo, your Waseet assistant. I can explain the platform and help you prepare projects, proposals, and review available information. How can I help?';
  }
  return undefined;
}

export function greetingResponseForSkin(skin?: string): string {
  if (skin === 'scout') {
    return (
      'أهلاً وسهلاً بك! أنا نديم، دليلك الذكي في منصة وسيط للخدمات المهنية والضمان المالي (Escrow).\n\n' +
      'أنا بخير ويسعدني تواصلك! يمكنني مساعدتك في:\n' +
      '• شرح كيفية عمل الضمان المالي لحماية المعاملات.\n' +
      '• خطوات نشر المشاريع، وتقديم العروض، وإدارة مراحل التسليم (Milestones).\n' +
      '• توضيح آليات تقييم جودة التسليمات وحل النزاعات.\n\n' +
      'كيف أستطيع مساعدتك اليوم؟'
    );
  }
  return (
    'أهلاً وسهلاً بك! أنا بيبو، مساعدك الذكي في منصة وسيط للخدمات المهنية والضمان المالي (Escrow).\n\n' +
    'أنا بخير ويسعدني تواصلك! يمكنني مساعدتك في:\n' +
    '• شرح كيفية عمل الضمان المالي لحماية المعاملات.\n' +
    '• خطوات نشر المشاريع، وتقديم العروض، وإدارة مراحل التسليم (Milestones).\n' +
    '• توضيح آليات تقييم جودة التسليمات وحل النزاعات.\n\n' +
    'كيف أستطيع مساعدتك اليوم؟'
  );
}
