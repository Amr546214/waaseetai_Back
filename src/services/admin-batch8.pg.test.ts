import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, closeEnv } from '../testing/admin-operations.pgenv';
after(closeEnv);

const set = async (e: any, key: string, value: unknown) => {
 await e.prisma.platformSetting.upsert({where:{key},create:{key,value},update:{value,version:{increment:1}}});
 (await import('./system-settings.service')).systemSettingsService.invalidate();
};

test('taxonomy uses one current name, updates live legacy references and rolls back invalid writes',opts,async()=>{
 const e=await env();const {AdminSpecialtiesService}=await import('./admin-specialties.service');const s=new AdminSpecialtiesService();
 const id=randomUUID(); const category=await s.createCategory({slug:`qa-${id}`,nameAr:'قسم تجريبي'});
 const specialty=await s.createSpecialty({categoryId:category.id,slug:`spec-${id}`,nameAr:'اسم قديم'});
 assert.equal(category.name,category.nameAr);assert.equal(specialty.name,specialty.nameAr);
 const u=await e.mkUser('PROVIDER_INDIVIDUAL','catalog');
 const profile=await e.prisma.providerProfile.create({data:{userId:u.id,mainSpecialty:category.slug,subSpecialties:[specialty.nameAr]}});
 const project=await e.prisma.project.create({data:{clientId:u.id,title:'synthetic',description:'synthetic',specialty:category.slug,subSpecialties:[specialty.nameAr],deliveryDays:1}});
 await s.updateSpecialty(specialty.id,{nameAr:'اسم جديد'});
 assert.equal((await e.prisma.specialty.findUnique({where:{id:specialty.id}})).name,'اسم جديد');
 assert.deepEqual((await e.prisma.providerProfile.findUnique({where:{id:profile.id}})).subSpecialties,['اسم جديد']);
 assert.deepEqual((await e.prisma.project.findUnique({where:{id:project.id}})).subSpecialties,['اسم جديد']);
 await s.updateCategory(category.id,{slug:`new-${id}`,nameAr:'قسم معدل'});
 assert.equal((await e.prisma.providerProfile.findUnique({where:{id:profile.id}})).mainSpecialty,`new-${id}`);
 assert.equal((await e.prisma.project.findUnique({where:{id:project.id}})).specialty,`new-${id}`);
 const publicService=(await import('./specialty.service')).specialtyService;
 const rows=await publicService.getPublicSpecialties(category.id);assert.ok(rows.some((r:any)=>r.id===specialty.id&&r.name==='اسم جديد'));
 await s.toggleCategoryStatus(category.id);
 assert.equal((await publicService.getPublicSpecialties(category.id)).length,0);
 const duplicate=await s.createCategory({slug:`dup-${id}`,nameAr:'ثانٍ'});
 await assert.rejects(()=>s.updateCategory(category.id,{slug:duplicate.slug,nameAr:'should rollback'}));
 assert.equal((await e.prisma.category.findUnique({where:{id:category.id}})).nameAr,'قسم معدل');
});

test('announcements pause centrally, preserve one inbox copy and email retry state across concurrent workers',opts,async()=>{
 const e=await env();const c=await import('./admin-communications.service');const {notificationService}=await import('./notification.service');
 process.env.SMTP_HOST='synthetic.invalid';process.env.SMTP_USER='synthetic';process.env.SMTP_PASS='synthetic';
 await set(e,'channelEmail',true);await set(e,'adminBroadcastEnabled',true);
 const user=await e.mkUser('CLIENT_INDIVIDUAL','mail');
 const b=await c.draftBroadcast(e.sa.id,{requestKey:randomUUID(),title:'synthetic email',message:'not sent externally',audience:'CLIENT',emailRequested:true});
 const preview=await c.previewBroadcast(b.id);
 await set(e,'adminBroadcastEnabled',false);
 await assert.rejects(()=>c.sendBroadcast(e.sa.id,b.id,1,preview.recipients),/متوقف/);
 await set(e,'adminBroadcastEnabled',true);await c.sendBroadcast(e.sa.id,b.id,1,preview.recipients);
 const calls=new Map<string,number>();let fail=true;
 const original=notificationService.sendStoredBroadcastEmail;
 notificationService.sendStoredBroadcastEmail=async id=>{calls.set(id,(calls.get(id)||0)+1);return fail?{status:'FAILED',reason:'SYNTHETIC'}:{status:'SENT'};};
 try {
  await set(e,'adminBroadcastEnabled',false);await c.processBroadcastBatch();
  assert.equal(await e.prisma.notification.count({where:{type:'ADMIN_BROADCAST',metadata:{path:['broadcastId'],equals:b.id}}}),0);
  await set(e,'adminBroadcastEnabled',true);await Promise.all([c.processBroadcastBatch(),c.processBroadcastBatch()]);
  const d=await e.prisma.adminBroadcastDelivery.findUnique({where:{broadcastId_userId:{broadcastId:b.id,userId:user.id}}});
  assert.equal(d.status,'SENT');assert.equal(d.emailStatus,'RETRY');assert.equal(calls.get(d.notificationId),1);
  assert.equal((await e.prisma.adminBroadcast.findUnique({where:{id:b.id}})).status,'SENDING');
  fail=false;await e.prisma.adminBroadcastDelivery.updateMany({where:{broadcastId:b.id,emailStatus:'RETRY'},data:{emailNextAt:new Date(0)}});
  await Promise.all([c.processBroadcastBatch(),c.processBroadcastBatch()]);
  assert.equal((await e.prisma.adminBroadcastDelivery.findUnique({where:{id:d.id}})).emailStatus,'SENT');
  assert.equal(await e.prisma.notification.count({where:{id:d.notificationId}}),1);
  assert.equal(calls.get(d.notificationId),2);
  assert.equal((await e.prisma.adminBroadcast.findUnique({where:{id:b.id}})).status,'COMPLETED');
 } finally {notificationService.sendStoredBroadcastEmail=original;}
 const unknown=await c.draftBroadcast(e.sa.id,{requestKey:randomUUID(),title:'uncertain',message:'test',audience:'CLIENT',emailRequested:true});
 const p=await c.previewBroadcast(unknown.id);await c.sendBroadcast(e.sa.id,unknown.id,1,p.recipients);
 await e.prisma.adminBroadcastDelivery.updateMany({where:{broadcastId:unknown.id},data:{status:'SENT',emailStatus:'SENDING',emailLeaseAt:new Date(0)}});
 await c.processBroadcastBatch();
 assert.equal(await e.prisma.adminBroadcastDelivery.count({where:{broadcastId:unknown.id,emailStatus:'UNKNOWN'}}),p.recipients);
});

test('broadcast mail uses real preference rules and durable mail claim with a stub SMTP transport',opts,async()=>{
 const e=await env();const {notificationService}=await import('./notification.service');const {mailTransporter}=await import('../utils/mail.transporter');
 await set(e,'channelEmail',true);
 const user=await e.mkUser('CLIENT_INDIVIDUAL','email-optin');
 await e.prisma.notificationPreference.create({data:{userId:user.id,settings:{channel_email:true}}});
 const n=await e.prisma.notification.create({data:{userId:user.id,title:'<script>title</script>',message:'<img src=x onerror=alert(1)>',type:'ADMIN_BROADCAST',category:'ALL'}});
 const original=mailTransporter.sendMail;const mails:any[]=[];
 mailTransporter.sendMail=(async(m:any)=>{mails.push(m);return {accepted:[user.email],rejected:[]};}) as any;
 try {
  assert.equal((await notificationService.sendStoredBroadcastEmail(n.id)).status,'SENT');
  assert.equal((await notificationService.sendStoredBroadcastEmail(n.id)).status,'UNKNOWN');
  assert.equal(mails.length,1);assert.ok(mails[0].text.includes('<img'));
  assert.ok(!mails[0].html.includes('<script>title'));
  assert.ok(!mails[0].html.includes('<img src=x'));
  await e.prisma.notificationPreference.update({where:{userId:user.id},data:{settings:{channel_email:false}}});
  assert.equal((await notificationService.sendStoredBroadcastEmail(n.id)).status,'SKIPPED');
  assert.equal(mails.length,1);
 } finally {mailTransporter.sendMail=original;}
});

test('dev reset denies production, requires maintenance, confirms an exact preview, preserves admin access, and is single-use',opts,async()=>{
 const e=await env();const reset=await import('./dev-data-reset.service');
 process.env.FRONTEND_URL='https://dev.waseetai.com';process.env.DEV_RESET_DATABASE_NAME=new URL(process.env.DATABASE_URL!).pathname.slice(1);
 process.env.PLATFORM_DEPLOY_ENV='official';assert.equal((await reset.devResetCapability()).allowed,false);
 await assert.rejects(()=>reset.previewDevReset(e.sa.id));delete process.env.PLATFORM_DEPLOY_ENV;
 await set(e,'maintenanceMode',false);await assert.rejects(()=>reset.previewDevReset(e.sa.id),/الصيانة/);
 await set(e,'maintenanceMode',true);
 const u=await e.mkUser('CLIENT_INDIVIDUAL','resetme');
 await e.prisma.adminBroadcast.updateMany({where:{status:'SENDING'},data:{status:'CANCELLED'}});
 const p=await reset.previewDevReset(e.sa.id);
 await assert.rejects(()=>reset.executeDevReset(e.sa.id,{backupConfirmed:true,token:p.token,confirmation:'wrong',reason:'isolated test'}),/التأكيد/);
 await e.mkUser('CLIENT_INDIVIDUAL','changed');
 await assert.rejects(()=>reset.executeDevReset(e.sa.id,{backupConfirmed:true,token:p.token,confirmation:reset.RESET_CONFIRMATION,reason:'isolated test'}),/تغيّرت/);
 const exact=await reset.previewDevReset(e.sa.id);
 const result=await reset.executeDevReset(e.sa.id,{backupConfirmed:true,token:exact.token,confirmation:reset.RESET_CONFIRMATION,reason:'isolated test only'});
 assert.equal(result.cleared,true);assert.equal(await e.prisma.user.findUnique({where:{id:u.id}}),null);
 assert.ok(await e.prisma.user.findUnique({where:{id:e.sa.id}}));
 assert.equal((await e.prisma.platformSetting.findUnique({where:{key:'maintenanceMode'}})).value,true);
 assert.ok(await e.prisma.accountAuditLog.findFirst({where:{userId:e.sa.id,eventType:'DEV_DATA_RESET'}}));
 await assert.rejects(()=>reset.executeDevReset(e.sa.id,{backupConfirmed:true,token:exact.token,confirmation:reset.RESET_CONFIRMATION,reason:'replayed test'}),/استُخدمت/);
});
