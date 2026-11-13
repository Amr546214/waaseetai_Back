import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { adminAudit } from './admin-audit.service';
import { cashbackGate, CASHBACK_FORMULA_CODE } from '../config/cashback-policy';
import { accrueCashbackForDeliveryCompletion, notifyCashbackCredited } from './cashback.service';

export async function listCashback(page=1) {
 const [pending, entries, total] = await prisma.$transaction([
  prisma.cashbackReview.findMany({ where: { status: { not: 'CREDITED' } }, orderBy: [{ completedAt:'asc' },{ id:'asc' }], take:30, skip:(Math.max(1,page)-1)*30 }),
  prisma.clientCashbackEntry.findMany({ orderBy:{ createdAt:'desc' },take:30,skip:(Math.max(1,page)-1)*30 }), prisma.cashbackReview.count({ where:{status:{not:'CREDITED'}} })
 ]);
 return { gate: cashbackGate(), formula:CASHBACK_FORMULA_CODE, pending, entries, total, page, pageSize:30, policy:'درجة سداد مسجلة من 100 لكل عقد؛ انتظار تقييم حقيقي؛ إضافة فورية عند اكتمال المدخلات. لا استحقاق للإغلاق الإداري أو التراضي، ولا احتساب تاريخي تلقائي.' };
}
export async function processCashback(contractId: string, actor?: { id:string; score:number; note:string; version:number }) {
 const outcome = await prisma.$transaction(async tx => {
  const c = await tx.contract.findUnique({where:{id:contractId},select:{id:true,projectId:true,clientId:true,status:true}});
  if (!c) throw new AppError('العقد غير موجود',404);
  // Match the financial lock hierarchy (request, contract, then review/user).
  await tx.$queryRaw`SELECT id FROM client_requests WHERE id=${c.projectId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM contracts WHERE id=${c.id} FOR UPDATE`;
  const r = await tx.cashbackReview.findUnique({where:{contractId}});
  if(!r) throw new AppError('لا يوجد استحقاق مسجل لهذا العقد',404);
  if(r.status==='CREDITED') return {status:'DUPLICATE'} as const;
  if(c.status!=='COMPLETED' || await tx.engagementClosure.findUnique({where:{projectId:c.projectId}})) throw new AppError('هذا العقد غير مؤهل لكاش باك التسليم',409);
  if(actor) {
   const u = await tx.cashbackReview.updateMany({where:{id:r.id,version:actor.version,status:{not:'CREDITED'}},data:{status:'WAITING_RATING',paymentInput:actor.score,paymentNote:actor.note,reviewedById:actor.id,version:{increment:1}}});
   if(!u.count) throw new AppError('تغير الاستحقاق؛ أعد التحميل',409);
   await adminAudit.recordTx(tx,{adminId:actor.id,entity:'FINANCE',entityId:r.id,eventType:'CASHBACK_PAYMENT_SCORE_RECORDED',title:'اعتماد درجة سداد الكاش باك',summary:'سُجلت درجة سداد للعقد',details:{contractId,score:actor.score,reason:actor.note}});
  }
  return accrueCashbackForDeliveryCompletion(tx,c);
 });
 if(outcome.status==='CREDITED') await notifyCashbackCredited(outcome.notice);
 return outcome;
}
export async function resumeClientCashback(userId:string) {
 const rows=await prisma.cashbackReview.findMany({where:{userId,status:'WAITING_RATING',paymentInput:{not:null}},select:{contractId:true},take:100});
 for(const row of rows) await processCashback(row.contractId);
}
