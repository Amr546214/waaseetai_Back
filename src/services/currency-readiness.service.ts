import { prisma as defaultPrisma } from '../config/db';
import { LEGACY_CURRENCY } from '../utils/currency';

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
	const fx = await tableExists(db, 'fx_conversions');
	if (!balances) blockers.push({ code: 'WALLET_BALANCE_PER_CURRENCY_MISSING', message: 'لا يوجد رصيد محفظة لكل عملة (wallet_balances)؛ يلزم دون إعادة تسمية الرصيد القائم.' });
	if (!fx) blockers.push({ code: 'FX_RECORD_MISSING', message: 'لا يوجد سجل تحويل (fx_conversions)؛ لا يُسمح بأي معاملة عابرة للعملات.' });
	// the ledger tables had a stale 'SAR' default: a SAR label that no SAR rail produced is a LABEL error, and base-currency totals must not be built on unverified labels
	const stale = await unverifiedLedgerLabels(db);
	if (stale > 0) blockers.push({ code: 'LEDGER_CURRENCY_LABELS_UNVERIFIED', message: `يوجد ${stale} سجل مالي بعملة غير USD (سجلات المحفظة/السحب/العمولة). تحقق منها بـ scripts/currency-evidence-probe.sql واعتمد تصحيحها (scripts/currency-label-correction.sql) قبل أي تغيير للعملة الأساسية.` });
	if (AGGREGATIONS_STILL_CURRENCY_BLIND.length) blockers.push({ code: 'AGGREGATIONS_NOT_PER_CURRENCY', message: `تجميعات لم تُفصل بالعملة بعد: ${AGGREGATIONS_STILL_CURRENCY_BLIND.join('، ')}.` });
	return { ready: blockers.length === 0, blockers };
}

/** Aggregations that already separate currencies (admin finance overview; escrow-based dashboard figures) are not listed. Each one still listed shrinks only when it is converted AND tested. */
export const AGGREGATIONS_STILL_CURRENCY_BLIND = [
	'ملخص المشرف/التحليلات (admin-analytics)', 'لوحة العميل/مقدم الخدمة (dashboard.service)', 'تقارير مقدم الخدمة والعميل (provider/client-reports)',
	'محفظة مقدم الخدمة (provider-finance)', 'محفظة الوسيط وملخصه (marketer-wallet / marketer-overview)', 'مجاميع السحب (withdrawal.service)', 'عمليات الإدارة (admin-operations)',
] as const;

async function tableExists(db: typeof defaultPrisma, name: string): Promise<boolean> {
	try { return (await db.$queryRaw<Array<{ n: string }>>`SELECT table_name AS n FROM information_schema.tables WHERE table_name = ${name} AND table_schema = 'public'`).length > 0; } catch { return false; }
}
async function unverifiedLedgerLabels(db: typeof defaultPrisma): Promise<number> {
	try {
		const r = await db.$queryRaw<Array<{ n: bigint }>>`SELECT (SELECT COUNT(*) FROM wallet_transactions WHERE currency <> ${LEGACY_CURRENCY}) + (SELECT COUNT(*) FROM withdrawals WHERE currency <> ${LEGACY_CURRENCY}) + (SELECT COUNT(*) FROM commission_logs WHERE currency <> ${LEGACY_CURRENCY}) AS n`;
		return Number(r[0]?.n ?? 0);
	} catch { return 0; }
}
