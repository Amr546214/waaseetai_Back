import { createHash } from 'node:crypto';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { round2 } from '../utils/money';
import { adminAudit } from './admin-audit.service';

export const expenseCategories = ['HOSTING', 'AI', 'SOFTWARE', 'OPERATIONS', 'OTHER'] as const;
export const operatingResult = (revenue: number, affiliate: number, cashback: number, expenses: number) => round2(revenue - affiliate - cashback - expenses);
const audit = (actor: string, id: string, eventType: string, details: Record<string, unknown>) => ({ adminId: actor, entity: 'FINANCE' as const, entityId: id, eventType, title: 'سجل المصروفات التشغيلية', summary: 'تحديث موثق في سجل المصروفات', details });
export class AdminOperatingFinanceService {
 async list(page = 1) {
  page = Math.max(1, Math.floor(page) || 1);
  const [rows, total] = await prisma.$transaction([prisma.adminExpense.findMany({ orderBy: [{ incurredAt: 'desc' }, { id: 'desc' }], skip: (page-1)*30, take: 30 }), prisma.adminExpense.count()]);
  return { rows, total, page, pageSize: 30 };
 }
 async record(actor: string, input: { requestKey: string; amount: number; category: string; description: string; reference?: string; incurredAt: string }) {
  const canonical = { amount: round2(input.amount), category: input.category, description: input.description.trim(), reference: input.reference?.trim() || null, incurredAt: new Date(input.incurredAt).toISOString() };
  const payloadHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return prisma.$transaction(async tx => {
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`expense:${input.requestKey}`}))`;
   const old = await tx.adminExpense.findUnique({ where: { requestKey: input.requestKey } });
   if (old) { if (old.payloadHash !== payloadHash || old.createdById !== actor) throw new AppError('مفتاح المحاولة مستخدم لبيانات مختلفة', 409); return old; }
   const row = await tx.adminExpense.create({ data: { ...canonical, requestKey: input.requestKey, payloadHash, createdById: actor } });
   await adminAudit.recordTx(tx, audit(actor, row.id, 'OPERATING_EXPENSE_RECORDED', { amount: canonical.amount, category: row.category }));
   return row;
  });
 }
 async void(actor: string, id: string, version: number, reason: string) {
  return prisma.$transaction(async tx => {
   const r = await tx.adminExpense.updateMany({ where: { id, version, status: 'RECORDED' }, data: { status: 'VOIDED', voidReason: reason, voidedById: actor, version: { increment: 1 } } });
   if (!r.count) throw new AppError('تغير المصروف أو أُلغي؛ أعد التحميل', 409);
   await adminAudit.recordTx(tx, audit(actor, id, 'OPERATING_EXPENSE_VOIDED', { reason }));
   return tx.adminExpense.findUniqueOrThrow({ where: { id } });
  });
 }
 async result() {
  // A consistent cumulative accounting view. Escrow is the recognized commission source; deposits and provider funds never become platform income.
  return prisma.$transaction(async tx => {
   const [income, affiliate, cashback, expenses, count] = await Promise.all([
    tx.escrow.aggregate({ _sum: { platformCommissionAmount: true } }),
    tx.commissionLog.groupBy({ by: ['currency'], where: { status: { in: ['APPROVED', 'PAID'] } }, _sum: { amount: true } }),
    tx.clientCashbackEntry.aggregate({ where: { status: 'CREDITED', currency: 'USD' }, _sum: { amount: true } }),
    tx.adminExpense.aggregate({ where: { status: 'RECORDED', currency: 'USD' }, _sum: { amount: true } }), tx.adminExpense.count({ where: { status: 'RECORDED' } })
   ]);
   const revenue = round2(income._sum.platformCommissionAmount || 0), affiliateCost = round2(affiliate.filter(r => r.currency === 'USD').reduce((s,r) => s+(r._sum.amount || 0),0)), cashbackCost = round2(cashback._sum.amount || 0), operatingExpenses = round2(Number(expenses._sum.amount || 0));
   const foreignCommissions = affiliate.filter(r => r.currency !== 'USD' && Number(r._sum.amount)>0).map(r=>({ currency:r.currency, amount:r._sum.amount }));
   return { period: 'ALL_TIME', currency: 'USD', asOf: new Date(), revenue, affiliateCost, cashbackCost, operatingExpenses, expenseCount: count, net: foreignCommissions.length ? null : operatingResult(revenue, affiliateCost, cashbackCost, operatingExpenses), foreignCommissions, definition: 'نتيجة تراكمية من السجلات: عمولة المنصة المحررة − عمولات الوسطاء المعتمدة والمدفوعة (مرة واحدة) − الكاش باك المقيد − المصروفات المسجلة. الإيداعات والضمان ومستحقات المقدم ورسوم الإيداع التي يتحملها المودع خارج الحساب. أي مصروفات خارجية غير مسجلة غير مشمولة.' };
  }, { isolationLevel: 'RepeatableRead' });
 }
 async upcoming(page = 1) {
  page = Math.max(1, Math.floor(page) || 1);
  const where = { status: { in: ['PENDING', 'IN_PROGRESS'] as ('PENDING'|'IN_PROGRESS')[] }, deliveries: { none: {} }, contract: { status: 'ACTIVE' as const, project: { engagementClosure: null } } };
  const [stages, total] = await prisma.$transaction([prisma.projectStage.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 30, skip: (page-1)*30, include: { contract: { select: { projectId: true, adminFrozenAt: true, project: { select: { title: true } }, client: { select: { firstName: true, lastName: true } } } } } }), prisma.projectStage.count({ where })]);
  return { page, total, pageSize: 30, rows: stages.map(s=>({ id:s.id, contractId:s.contractId, projectId:s.contract.projectId, project:s.contract.project.title, client:`${s.contract.client.firstName} ${s.contract.client.lastName}`, title:s.title, amount:s.amount, currency:'USD', frozen:!!s.contract.adminFrozenAt, dueAt:s.startedAt ? new Date(s.startedAt.getTime()+s.days*86400000) : null, status:s.status })) };
 }
}
export const operatingFinance = new AdminOperatingFinanceService();
