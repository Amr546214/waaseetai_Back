import { markSettingsChanged } from './settings-revision';
import { randomUUID } from 'node:crypto';
import { AccountType, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { adminAudit } from './admin-audit.service';
import { systemSettingsService } from './system-settings.service';
import { notificationService } from './notification.service';

export const contentTitles: Record<string,string> = { terms:'شروط الاستخدام', privacy:'سياسة الخصوصية', faq:'الأسئلة الشائعة', about:'من نحن', how:'كيف يعمل', contact:'تواصل معنا', welcome:'رسالة الترحيب' };
const audit = (adminId:string, entityId:string,eventType:string, details:Record<string,unknown>={}) => ({adminId,entity:'FINANCE' as const,entityId,eventType,title:'إدارة المحتوى والتواصل',summary:'تحديث موثق في نظام المحتوى والتواصل',details});
export async function contentPages() {
 const [rows,settings] = await prisma.$transaction([prisma.adminContentPage.findMany(),prisma.platformSetting.findMany({where:{key:{in:['termsContent','privacyContent']}}})]);
 return Object.entries(contentTitles).map(([slug,title])=> rows.find(r=>r.slug===slug) ?? {slug,title,draft: String(settings.find(s=>s.key===`${slug}Content`)?.value || ''),published:null,publishedAt:null,updatedAt:null,version:0});
}
export async function saveContent(actor:string,slug:string,input:{body:string;version:number;action:'DRAFT'|'PUBLISH'|'UNPUBLISH';reason:string}) {
 if(!contentTitles[slug]) throw new AppError('صفحة غير معروفة',404);
 const row=await prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cms:${slug}`}))`;
  const old=await tx.adminContentPage.findUnique({where:{slug}});
  if((old?.version || 0)!==input.version) throw new AppError('تغيرت الصفحة من مدير آخر؛ أعد تحميلها قبل الحفظ',409);
  const data={title:contentTitles[slug],draft:input.body,updatedById:actor,...(input.action==='PUBLISH'?{published:input.body,publishedAt:new Date()}:input.action==='UNPUBLISH'?{published:null,publishedAt:null}:{})};
  const saved=old?await tx.adminContentPage.update({where:{slug},data:{...data,version:{increment:1}}}):await tx.adminContentPage.create({data:{slug,...data}});
  if((slug==='terms'||slug==='privacy')&&input.action!=='DRAFT') {
   const key=`${slug}Content`,value=input.action==='PUBLISH'?input.body:'';
   await tx.platformSetting.upsert({where:{key},create:{key,value,updatedBy:actor},update:{value,updatedBy:actor,version:{increment:1}}});
   await markSettingsChanged(tx,[key]);
  }
  await adminAudit.recordTx(tx,audit(actor,slug,`CMS_${input.action}`,{version:saved.version,reason:input.reason}));
  return saved;
 });
 systemSettingsService.invalidate();
 return row;
}
export async function publishedContent(slug:string) {
 if(!contentTitles[slug]) throw new AppError('صفحة غير معروفة',404);
 return prisma.adminContentPage.findUnique({where:{slug},select:{slug:true,title:true,published:true,publishedAt:true,version:true}});
}
export const audiences = ['ALL','CLIENT','PROVIDER','MARKETER','ADMIN'] as const;
export function recipientWhere(audience:string):Prisma.UserWhereInput {
 const types:Record<string,AccountType[]>={CLIENT:['CLIENT_COMPANY','CLIENT_INDIVIDUAL'],PROVIDER:['PROVIDER_COMPANY','PROVIDER_INDIVIDUAL'],MARKETER:['MARKETING_BROKER'],ADMIN:['ADMIN','SUPER_ADMIN']};
 return {status:'ACTIVE',isBanned:false, ...(types[audience]?{accountType:{in:types[audience]}}:{}), NOT:{adminStaff:{status:'SUSPENDED'}}};
}
export async function broadcastList() { return prisma.adminBroadcast.findMany({orderBy:{createdAt:'desc'},take:50}); }
export async function draftBroadcast(actor:string,b:{requestKey:string;title:string;message:string;audience:string}) {
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`broadcast-key:${b.requestKey}`}))`;
  const old=await tx.adminBroadcast.findUnique({where:{requestKey:b.requestKey}});
  if(old) {if(old.createdById!==actor||old.title!==b.title||old.message!==b.message||old.audience!==b.audience)throw new AppError('مفتاح المحاولة مستخدم لرسالة مختلفة',409);return old;}
  const row=await tx.adminBroadcast.create({data:{...b,createdById:actor}});
  await adminAudit.recordTx(tx,audit(actor,row.id,'BROADCAST_DRAFT_CREATED',{audience:b.audience}));
  return row;
 });
}
export async function previewBroadcast(id:string) {
 const b=await prisma.adminBroadcast.findUniqueOrThrow({where:{id}});
 return {id,version:b.version,recipients:await prisma.user.count({where:recipientWhere(b.audience)}),channel:'IN_APP',audience:b.audience};
}
export async function sendBroadcast(actor:string,id:string,version:number,expectedCount:number,cancel=false) {
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`broadcast:${id}`}))`;
  const b=await tx.adminBroadcast.findUnique({where:{id}});if(!b)throw new AppError('الرسالة غير موجودة',404);
  if(cancel&&b.status==='CANCELLED')return b;
  if(!cancel&&b.status!=='DRAFT') {if(b.status==='CANCELLED')throw new AppError('الرسالة ملغاة',409);return b;}
  if(b.version!==version)throw new AppError('تغيرت الرسالة؛ أعد المعاينة',409);
  if(cancel&&b.status==='COMPLETED')throw new AppError('اكتمل الإرسال ولا يمكن سحب الإشعارات',409);
  let count=b.recipientCount;
  if(!cancel) {
   // Freeze the actual audience at confirmation. No notification is sent by preview or drafting.
   const users=await tx.user.findMany({where:recipientWhere(b.audience),select:{id:true}});count=users.length;
   if(count!==expectedCount)throw new AppError('تغير عدد المستلمين؛ أعد المعاينة والتأكيد',409);
   if(!count)throw new AppError('لا يوجد مستلمون مطابقون',400);
   for(let i=0;i<users.length;i+=500)await tx.adminBroadcastDelivery.createMany({data:users.slice(i,i+500).map(u=>({broadcastId:id,userId:u.id,notificationId:randomUUID()}))});
  }
  const row=await tx.adminBroadcast.update({where:{id},data:{status:cancel?'CANCELLED':'SENDING',recipientCount:count,snapshotAt:cancel?b.snapshotAt:new Date(),version:{increment:1}}});
  await adminAudit.recordTx(tx,audit(actor,id,cancel?'BROADCAST_CANCELLED':'BROADCAST_CONFIRMED',{recipients:count,channel:'IN_APP'}));return row;
 },{timeout:30000,isolationLevel:'RepeatableRead'});
}
/** At-least-once socket delivery, exactly one durable inbox notification per recipient. Safe across restarts and replicas. */
export async function processBroadcastBatch() {
 const jobs=await prisma.adminBroadcast.findMany({where:{status:'SENDING'},orderBy:{createdAt:'asc'},take:5,select:{id:true}});
 for(const job of jobs) {
  const emitted=await prisma.$transaction(async tx=>{
   const locked=await tx.$queryRaw<Array<{locked:boolean}>>`SELECT pg_try_advisory_xact_lock(hashtext(${`broadcast:${job.id}`})) AS locked`;
   if(!locked[0]?.locked)return [];
   const b=await tx.adminBroadcast.findUnique({where:{id:job.id}});if(!b||b.status!=='SENDING')return [];
   const rows=await tx.adminBroadcastDelivery.findMany({where:{broadcastId:b.id,status:'PENDING'},orderBy:{id:'asc'},take:100});
   for(const d of rows) {
    const user=await tx.user.findFirst({where:{id:d.userId,...recipientWhere(b.audience)},select:{id:true}});
    if(!user) {await tx.adminBroadcastDelivery.update({where:{id:d.id},data:{status:'FAILED',lastError:'RECIPIENT_NO_LONGER_ELIGIBLE'}});continue;}
    await tx.notification.create({data:{id:d.notificationId,userId:d.userId,title:b.title,message:b.message,type:'ADMIN_BROADCAST',category:'ALL',metadata:{broadcastId:b.id}}});
    await tx.adminBroadcastDelivery.update({where:{id:d.id},data:{status:'SENT',deliveredAt:new Date()}});
   }
   const [sent,failed,left]=await Promise.all([tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'SENT'}}),tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'FAILED'}}),tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'PENDING'}})]);
   await tx.adminBroadcast.update({where:{id:b.id},data:{sentCount:sent,failedCount:failed,...(!left?{status:'COMPLETED'}:{})}});
   return rows.map(r=>r.notificationId);
  },{timeout:30000});
  // Inbox persistence is the delivery guarantee; socket hints may be missed on process restart, and unread-list fetching still finds the notification.
  for(const id of emitted)await notificationService.emitStoredInApp(id).catch(()=>{});
 }
}
