export interface ContentPolicyCheckResult {
  blocked: boolean;
  category?: 'alcohol' | 'tax_evasion' | 'drugs' | 'gambling' | 'cybercrime' | 'adult';
  reasonAr?: string;
}

interface PolicyRule {
  category: NonNullable<ContentPolicyCheckResult['category']>;
  pattern: RegExp;
  reasonAr: string;
}

const normalizeArabic = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();

const POLICY_RULES: PolicyRule[] = [
  {
    category: 'alcohol',
    pattern:
      /(?:مشروبات\s*روحيه|المشروبات\s*الروحيه|مشروب\s*روحي|مشروبات\s*كحوليه|المشروبات\s*الكحوليه|مشروب\s*كحولي|بيع\s*الخمور|تجاره\s*الخمور|ترويج\s*الخمور|توصيل\s*خمور|متجر\s*خمور|(?<![\p{L}\p{N}_])خمور(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])خمر(?![\p{L}\p{N}_])|كحوليات|(?<![\p{L}\p{N}_])ويسكي(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])فودكا(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])نبيذ(?![\p{L}\p{N}_])|selling\s+alcohol|liquor\s+store|alcoholic\s+beverage)/iu,
    reasonAr:
      'عذراً، لا يمكن تنفيذ هذا الطلب أو توليد محتوى له لمخالفته سياسات منصة وسيط والأنظمة المرعية (يُمنع تداول أو ترويج المشروبات الروحية والكحولية).',
  },
  {
    category: 'tax_evasion',
    pattern:
      /(?:(?:ال)?تهرب\s*(?:ال)?ضريبي|تحايل\s*ضريبي|التحايل\s*الضريبي|اخفاء\s*الدخل\s*الضريبي|غسيل\s*اموال|غسل\s*اموال|غسيل\s*الاموال|تزوير\s*فواتير|فواتير\s*وهميه|تزوير\s*مستندات|تزوير\s*اوراق|تزوير\s*رسمي|اختلاس\s*اموال|tax\s+evasion|money\s+laundering|fake\s+invoices)/iu,
    reasonAr:
      'عذراً، هذا المحتوى مرفوض لمخالفته الأنظمة والقوانين وسياسات منصة وسيط (يُحظر تقديم أو طلب خدمات التهرب الضريبي أو التحايل المالي أو تزوير المستندات).',
  },
  {
    category: 'drugs',
    pattern:
      /(?:بيع\s*مخدرات|تجاره\s*المخدرات|ترويج\s*المخدرات|مواد\s*مخدره|(?<![\p{L}\p{N}_])مخدرات(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])حشيش(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])كبتاجون(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])هيروين(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])كوكايين(?![\p{L}\p{N}_])|illegal\s+drugs|narcotics)/iu,
    reasonAr:
      'عذراً، هذا المحتوى مرفوض لمخالفته الأنظمة وسياسات منصة وسيط (يُحظر تداول أو ترويج المواد المخدرة والمحظورة).',
  },
  {
    category: 'gambling',
    pattern:
      /(?:موقع\s*قمار|مواقع\s*قمار|تطبيق\s*قمار|لعب\s*القمار|مراهنات\s*ماليه|موقع\s*مراهنات|كازينو\s*قمار)/iu,
    reasonAr:
      'عذراً، هذا المحتوى مرفوض لمخالفته سياسات منصة وسيط (يُحظر تطوير أو ترويج أنشطة القمار والمراهنات المالية).',
  },
  {
    category: 'cybercrime',
    pattern:
      /(?:اختراق\s*حسابات|تهكير\s*حسابات|سرقه\s*حسابات|تهكير\s*مواقع|برمجيات\s*خبيثه|فيروس\s*فديه|سرقه\s*بطاقات)/iu,
    reasonAr:
      'عذراً، هذا المحتوى مرفوض لمخالفته الأنظمة وسياسات منصة وسيط (يُحظر طلب أو تقديم خدمات الاختراق غير القانوني أو البرمجيات الخبيثة).',
  },
  {
    category: 'adult',
    pattern:
      /(?:محتوي\s*اباحي|مواقع\s*اباحيه|افلام\s*اباحيه|صور\s*اباحيه|ترويج\s*اباحي)/iu,
    reasonAr:
      'عذراً، هذا المحتوى مرفوض لمخالفته الآداب العامة وسياسات منصة وسيط.',
  },
];

export function checkContentPolicy(rawText: string | undefined | null): ContentPolicyCheckResult {
  if (!rawText || typeof rawText !== 'string') {
    return { blocked: false };
  }
  const normalized = normalizeArabic(rawText);
  if (!normalized) {
    return { blocked: false };
  }
  for (const rule of POLICY_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        blocked: true,
        category: rule.category,
        reasonAr: rule.reasonAr,
      };
    }
  }
  return { blocked: false };
}

export function checkMultipleContentPolicy(
  texts: Array<string | undefined | null>,
): ContentPolicyCheckResult {
  const combined = texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).join(' | ');
  return checkContentPolicy(combined);
}
