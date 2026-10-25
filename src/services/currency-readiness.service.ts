import { prisma as defaultPrisma } from '../config/db';

/**
 * Can the platform base currency be changed safely? The server answers from FACTS about the schema/code, never from a flag someone can flip. Until every blocker is gone the setting
 * `baseCurrency` refuses any change (409 CURRENCY_CHANGE_NOT_READY) and lists what is missing, instead of saving a choice that cannot work. Design: admin-team/system-settings/CURRENCY-TRANSITION-DESIGN.md.
 */
export interface CurrencyBlocker { code: string; message: string }
/** every money table that must carry its own currency before a second currency can exist */
export const MONEY_TABLES = ['projects', 'client_requests', 'proposals', 'project_proposals', 'proposal_milestones', 'contracts', 'project_stages', 'escrows', 'project_amendments', 'service_catalogs', 'orders', 'coupons'] as const;

export async function currencyReadiness(db: typeof defaultPrisma = defaultPrisma): Promise<{ ready: boolean; blockers: CurrencyBlocker[] }> {
	const blockers: CurrencyBlocker[] = [];
	let have = new Set<string>(), balances = false;
	try {
		const cols = await db.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'currency' AND table_schema = 'public'`;
		have = new Set(cols.map(c => c.table_name));
		const t = await db.$queryRaw<Array<{ n: string }>>`SELECT table_name AS n FROM information_schema.tables WHERE table_name = 'wallet_balances' AND table_schema = 'public'`;
		balances = t.length > 0;
	} catch { blockers.push({ code: 'SCHEMA_UNREADABLE', message: 'تعذّر فحص مخطط قاعدة البيانات، فلا يُسمح بالتغيير.' }); }
	const missing = MONEY_TABLES.filter(t => !have.has(t));
	if (missing.length) blockers.push({ code: 'MONEY_TABLES_WITHOUT_CURRENCY', message: `جداول مالية بلا عمود عملة: ${missing.join('، ')}. كل مبلغ يجب أن تكون عملته معلومة قبل أي عملة ثانية.` });
	if (!balances) blockers.push({ code: 'WALLET_BALANCE_PER_CURRENCY_MISSING', message: 'رصيد المحفظة رقم واحد بلا عملة (users.walletBalance)؛ يلزم رصيد لكل عملة دون إعادة تسمية الرصيد القائم.' });
	blockers.push({ code: 'AGGREGATIONS_NOT_PER_CURRENCY', message: 'تجميعات الإدارة والمالية والعمولات والسحب تجمع المبالغ دون فصل العملة (وبعضها يفلتر USD ضمنيًا).' });
	blockers.push({ code: 'GATEWAY_CAPABILITY_MAP_MISSING', message: 'لا توجد خريطة قدرات للبوابات: PayPal مقيّدة بـUSD في الالتقاط والـwebhook والصرف وتحميل الـSDK، وحدود الإيداع مكتوبة بالدولار.' });
	blockers.push({ code: 'FX_RECORD_MISSING', message: 'لا يوجد سجل تحويل (سعر، مصدر، وقت، تقريب، رسوم)؛ لا يُسمح بأي معاملة عابرة للعملات.' });
	blockers.push({ code: 'CURRENCY_FORMATTER_MISSING', message: 'لا يوجد مُنسِّق عملة مركزي: الردود والبريد والإشعارات تحمل USD/$ كنصوص ثابتة.' });
	return { ready: blockers.length === 0, blockers };
}
