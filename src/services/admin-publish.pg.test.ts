import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env, opts, closeEnv, mkStaff } from '../testing/admin-operations.pgenv';
after(closeEnv);
const setting=async(e:any,key:string,value:unknown)=>{await e.prisma.platformSetting.upsert({where:{key},create:{key,value},update:{value,version:{increment:1}}});(await import('./system-settings.service')).systemSettingsService.invalidate();};

test('one publish action snapshots the target audience, idempotent double clicks create one campaign and delivery set',opts,async()=>{
 const e=await env();const svc=await import('./admin-communications.service');
 await setting(e,'adminBroadcastEnabled',true);await setting(e,'channelEmail',false);
 const provider=await e.mkUser('PROVIDER_INDIVIDUAL','target'),client=await e.mkUser('CLIENT_INDIVIDUAL','other'),banned=await e.mkUser('PROVIDER_INDIVIDUAL','banned');
 await e.prisma.user.update({where:{id:banned.id},data:{isBanned:true}});
 const body={requestKey:randomUUID(),title:'one click',message:'isolated synthetic',audience:'PROVIDER'};
 const [a,b]=await Promise.all([svc.publishBroadcast(e.sa.id,body),svc.publishBroadcast(e.sa.id,body)]);
 assert.equal(a.id,b.id);assert.equal(a.status,'SENDING');assert.equal(a.emailRequested,false);
 assert.equal(await e.prisma.adminBroadcastDelivery.count({where:{broadcastId:a.id,userId:provider.id}}),1);
 assert.equal(await e.prisma.adminBroadcastDelivery.count({where:{broadcastId:a.id,userId:{in:[client.id,banned.id]}}}),0);
 await Promise.all([svc.processBroadcastBatch(a.id),svc.processBroadcastBatch(a.id)]);
 const delivery=await e.prisma.adminBroadcastDelivery.findUnique({where:{broadcastId_userId:{broadcastId:a.id,userId:provider.id}}});
 assert.equal(delivery.status,'SENT');assert.equal(delivery.emailStatus,'SKIPPED');
 assert.equal(await e.prisma.notification.count({where:{id:delivery.notificationId}}),1);
 await assert.rejects(()=>svc.publishBroadcast(e.sa.id,{...body,message:'different'}),/مختلفة/);
 await setting(e,'adminBroadcastEnabled',false);await assert.rejects(()=>svc.publishBroadcast(e.sa.id,{...body,requestKey:randomUUID()}),/متوقف/);
 await setting(e,'adminBroadcastEnabled',true);
});

test('enabled email is queued without blocking site delivery while SMTP is unconfigured; existing drafts publish in one action',opts,async()=>{
 const e=await env();const svc=await import('./admin-communications.service');await setting(e,'channelEmail',true);
 delete process.env.SMTP_HOST;delete process.env.SMTP_USER;delete process.env.SMTP_PASS;
 const c=await svc.publishBroadcast(e.sa.id,{requestKey:randomUUID(),title:'email queue',message:'no external mail',audience:'ALL'});
 assert.equal(c.emailRequested,true);await svc.processBroadcastBatch(c.id);
 const d=await e.prisma.adminBroadcastDelivery.findFirst({where:{broadcastId:c.id}});assert.equal(d.status,'SENT');assert.equal(d.emailStatus,'PENDING');
 const legacy=await svc.draftBroadcast(e.sa.id,{requestKey:randomUUID(),title:'legacy',message:'old form',audience:'ALL',emailRequested:true});
 await setting(e,'channelEmail',false);const published=await svc.publishSavedBroadcast(e.sa.id,legacy.id,legacy.version);assert.equal(published.status,'SENDING');assert.equal(published.emailRequested,false);
});

test('the real page copy is versioned, public-only published values, escaped text and guarded writes',opts,async()=>{
 const e=await env();const {publishPageCopy,publishedContent}=await import('./admin-communications.service');const staff=(await mkStaff(e,['finance.read'],'not-editor')).user;
 const copy={version:1 as const,edits:[{key:'h1.0/text.0:abc',original:'Original',value:'<script>plain text</script>'}]};
 assert.equal((await e.call('PUT','/admin/operations/content/privacy/copy',staff.id,{copy,version:0})).status,403);
 assert.equal((await e.call('PUT','/admin/operations/content/privacy/copy',e.sa.id,{copy:{version:1,edits:[{key:'x',original:'x',value:'x',html:'bad'}]},version:0})).status,400);
 const before=await e.prisma.adminContentPage.findUnique({where:{slug:'privacy'}});
 const row=await publishPageCopy(e.sa.id,'privacy',{copy,version:before?.version??0});
 const pub=await publishedContent('privacy');assert.deepEqual(pub?.publishedCopy,copy);assert.equal('draftCopy' in pub!,false);assert.equal('updatedById' in pub!,false);
 await assert.rejects(()=>publishPageCopy(e.sa.id,'privacy',{copy,version:row.version-1}),/تغيرت/);
 await assert.rejects(()=>publishPageCopy(randomUUID(),'privacy',{copy:{version:1,edits:[]},version:row.version}));
 assert.deepEqual((await publishedContent('privacy'))?.publishedCopy,copy,'audit failure rolls back publication');
 assert.equal(await e.prisma.platformSetting.findUnique({where:{key:'privacyContent'}}),null,'structured text never replaces the legal page source with JSON');
});
