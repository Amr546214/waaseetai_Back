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
export async function broadcastCapabilities() {
 const rows = await prisma.platformSetting.findMany({where:{key:{in:['adminBroadcastEnabled','channelEmail']}},select:{key:true,value:true}});
 const read = (key:string) => {const row=rows.find(r=>r.key===key);return row?row.value===true:true;};
 const enabled = read('adminBroadcastEnabled');
 const emailEnabled = read('channelEmail');
 const smtpConfigured = !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
 return { enabled, emailEnabled, smtpConfigured, emailReady: emailEnabled && smtpConfigured };
}
async function assertBroadcastEnabled(emailRequested = false) {
 const c = await broadcastCapabilities();
 if (!c.enabled) throw new AppError('إرسال الإعلانات متوقف من إعدادات النظام.', 403);
 if (emailRequested && !c.emailReady) throw new AppError('البريد غير جاهز: فعّل قناة البريد واضبط SMTP على الخادم، أو اختر الإرسال داخل الموقع فقط.', 409);
}
export async function broadcastList() {
 const rows = await prisma.adminBroadcast.findMany({orderBy:{createdAt:'desc'},take:50});
 const counts = await prisma.adminBroadcastDelivery.groupBy({ by: ['broadcastId','emailStatus'], where: { broadcastId: { in: rows.map(r=>r.id) } }, _count: true });
 return rows.map(row=>({ ...row, emailCounts: Object.fromEntries(counts.filter(c=>c.broadcastId===row.id).map(c=>[c.emailStatus,c._count])) }));
}
export async function draftBroadcast(actor:string,b:{requestKey:string;title:string;message:string;audience:string;emailRequested?:boolean}) {
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`broadcast-key:${b.requestKey}`}))`;
  const old=await tx.adminBroadcast.findUnique({where:{requestKey:b.requestKey}});
  if(old) {if(old.createdById!==actor||old.title!==b.title||old.message!==b.message||old.audience!==b.audience||old.emailRequested!==(b.emailRequested===true))throw new AppError('مفتاح المحاولة مستخدم لرسالة مختلفة',409);return old;}
  const row=await tx.adminBroadcast.create({data:{...b,createdById:actor}});
  await adminAudit.recordTx(tx,audit(actor,row.id,'BROADCAST_DRAFT_CREATED',{audience:b.audience}));
  return row;
 });
}
export async function previewBroadcast(id:string) {
 const b=await prisma.adminBroadcast.findUniqueOrThrow({where:{id}});
 return {id,version:b.version,recipients:await prisma.user.count({where:recipientWhere(b.audience)}),channel:b.emailRequested?'IN_APP_AND_EMAIL':'IN_APP',audience:b.audience,capabilities:await broadcastCapabilities()};
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
   await assertBroadcastEnabled(b.emailRequested);
   // Freeze the actual audience at confirmation. No notification is sent by preview or drafting.
   const users=await tx.user.findMany({where:recipientWhere(b.audience),select:{id:true}});count=users.length;
   if(count!==expectedCount)throw new AppError('تغير عدد المستلمين؛ أعد المعاينة والتأكيد',409);
   if(!count)throw new AppError('لا يوجد مستلمون مطابقون',400);
   for(let i=0;i<users.length;i+=500)await tx.adminBroadcastDelivery.createMany({data:users.slice(i,i+500).map(u=>({broadcastId:id,userId:u.id,notificationId:randomUUID(),emailStatus:b.emailRequested?'PENDING':'SKIPPED'}))});
  }
  if(cancel) await tx.adminBroadcastDelivery.updateMany({where:{broadcastId:id,emailStatus:{in:['PENDING','RETRY']}},data:{emailStatus:'CANCELLED'}});
  const row=await tx.adminBroadcast.update({where:{id},data:{status:cancel?'CANCELLED':'SENDING',recipientCount:count,snapshotAt:cancel?b.snapshotAt:new Date(),version:{increment:1}}});
  await adminAudit.recordTx(tx,audit(actor,id,cancel?'BROADCAST_CANCELLED':'BROADCAST_CONFIRMED',{recipients:count,channel:b.emailRequested?'IN_APP_AND_EMAIL':'IN_APP'}));return row;
 },{timeout:30000,isolationLevel:'RepeatableRead'});
}
/** At-least-once socket delivery, exactly one durable inbox notification per recipient. Safe across restarts and replicas. */
export async function processBroadcastBatch() {
 if (!(await broadcastCapabilities()).enabled) return;
 const jobs=await prisma.adminBroadcast.findMany({where:{status:'SENDING',deliveries:{some:{status:'PENDING'}}},orderBy:{createdAt:'asc'},take:5,select:{id:true}});
 for(const job of jobs) {
  const emitted=await prisma.$transaction(async tx=>{
   const locked=await tx.$queryRaw<Array<{locked:boolean}>>`SELECT pg_try_advisory_xact_lock(hashtext(${`broadcast:${job.id}`})) AS locked`;
   if(!locked[0]?.locked)return [];
   const b=await tx.adminBroadcast.findUnique({where:{id:job.id}});if(!b||b.status!=='SENDING')return [];
   const rows=await tx.adminBroadcastDelivery.findMany({where:{broadcastId:b.id,status:'PENDING'},orderBy:{id:'asc'},take:100});
   for(const d of rows) {
    const user=await tx.user.findFirst({where:{id:d.userId,...recipientWhere(b.audience)},select:{id:true}});
    if(!user) {await tx.adminBroadcastDelivery.update({where:{id:d.id},data:{status:'FAILED',lastError:'RECIPIENT_NO_LONGER_ELIGIBLE',emailStatus:'SKIPPED'}});continue;}
    await tx.notification.create({data:{id:d.notificationId,userId:d.userId,title:b.title,message:b.message,type:'ADMIN_BROADCAST',category:'ALL',metadata:{broadcastId:b.id}}});
    await tx.adminBroadcastDelivery.update({where:{id:d.id},data:{status:'SENT',deliveredAt:new Date()}});
   }
   const [sent,failed,left]=await Promise.all([tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'SENT'}}),tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'FAILED'}}),tx.adminBroadcastDelivery.count({where:{broadcastId:b.id,status:'PENDING'}})]);
   await tx.adminBroadcast.update({where:{id:b.id},data:{sentCount:sent,failedCount:failed,...(!left&&!b.emailRequested?{status:'COMPLETED'}:{})}});
   return rows.map(r=>r.notificationId);
  },{timeout:30000});
  // Inbox persistence is the delivery guarantee; socket hints may be missed on process restart, and unread-list fetching still finds the notification.
  for(const id of emitted)await notificationService.emitStoredInApp(id).catch(()=>{});
 }

 await processBroadcastEmails();
 const sending = await prisma.adminBroadcast.findMany({ where: { status: 'SENDING' }, select: { id: true } });
 for (const b of sending) {
  await prisma.$transaction(async tx => {
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`broadcast:${b.id}`}))`;
   const pending = await tx.adminBroadcastDelivery.count({ where: { broadcastId: b.id, OR: [{ status: 'PENDING' }, { emailStatus: { in: ['PENDING','RETRY','SENDING'] } }] } });
   if (!pending) await tx.adminBroadcast.updateMany({ where: { id: b.id, status: 'SENDING' }, data: { status: 'COMPLETED' } });
  });
 }
}

async function processBroadcastEmails() {
 // A crashed SMTP call may already have been accepted: report UNKNOWN rather than resend silently.
 await prisma.adminBroadcastDelivery.updateMany({ where: { emailStatus:'SENDING',emailLeaseAt:{lt:new Date(Date.now()-300000)} },data:{emailStatus:'UNKNOWN',emailError:'SMTP_OUTCOME_UNKNOWN'} });
 const rows = await prisma.adminBroadcastDelivery.findMany({ where: { status:'SENT',emailStatus:{in:['PENDING','RETRY']}, OR:[{emailNextAt:null},{emailNextAt:{lte:new Date()}}], broadcast:{status:'SENDING'} }, orderBy:{id:'asc'},take:20 });
 for (const row of rows) {
  const caps = await broadcastCapabilities();
  if (!caps.enabled || !caps.emailReady) return; // pause, preserve recipient's queued delivery
  const claimed = await prisma.adminBroadcastDelivery.updateMany({where:{id:row.id,emailStatus:{in:['PENDING','RETRY']},broadcast:{status:'SENDING'}},data:{emailStatus:'SENDING',emailAttempts:{increment:1},emailLeaseAt:new Date()}});
  if (!claimed.count) continue;
  let result: {status:'SENT'|'FAILED'|'SKIPPED'|'UNKNOWN';reason?:string};
  try { result = await notificationService.sendStoredBroadcastEmail(row.notificationId); }
  catch { result = {status:'UNKNOWN',reason:'SMTP_OUTCOME_UNKNOWN'}; }
  const retry = result.status==='FAILED' && row.emailAttempts < 2;
  await prisma.adminBroadcastDelivery.updateMany({where:{id:row.id,emailStatus:'SENDING'},data:{emailStatus:retry?'RETRY':result.status,emailError:result.reason??null,emailSentAt:result.status==='SENT'?new Date():null,emailNextAt:retry?new Date(Date.now()+30000*2**row.emailAttempts):null,emailLeaseAt:null}});
 }
}
