import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env,opts,closeEnv,mkStaff } from '../testing/admin-operations.pgenv';
after(async()=>{await closeEnv();});

test('expense replay/concurrency, immutable void and audit rollback; actual cumulative operating result',opts,async()=>{
 const e=await env();const {operatingFinance}=await import('./admin-operating-finance.service');
 const before=await operatingFinance.result();const data={requestKey:randomUUID(),amount:125.35,category:'HOSTING',description:'synthetic expense',incurredAt:'2026-11-01T00:00:00Z'};
 const rows=await Promise.all([1,2,3].map(()=>operatingFinance.record(e.sa.id,data)));assert.equal(new Set(rows.map(r=>r.id)).size,1);
 assert.equal((await operatingFinance.result()).operatingExpenses,before.operatingExpenses+125.35);
 await assert.rejects(()=>operatingFinance.record(e.sa.id,{...data,amount:125.36}),/مختلفة/);
 assert.equal((await operatingFinance.result()).net,(before.net??0)-125.35);
 await operatingFinance.void(e.sa.id,rows[0].id,1,'synthetic correction');assert.equal((await operatingFinance.result()).operatingExpenses,before.operatingExpenses);
 await assert.rejects(()=>operatingFinance.void(e.sa.id,rows[0].id,1,'again'),/تغير/);
 await assert.rejects(()=>operatingFinance.record(randomUUID(),{...data,requestKey:randomUUID()}));
 assert.equal(await e.prisma.adminExpense.count({where:{status:'RECORDED',description:data.description}}),0,'audit FK failure rolls back expense');
});

test('operations HTTP permissions, validation and server persisted content publication with version conflicts',opts,async()=>{
 const e=await env();const reader=(await mkStaff(e,['finance.read'],'ops-reader')).user;
 assert.equal((await e.call('GET','/admin/operations/result',reader.id)).status,200);
 assert.equal((await e.call('POST','/admin/operations/expenses',reader.id,{})).status,403);
 assert.equal((await e.call('GET','/admin/operations/content',reader.id)).status,403);
 assert.equal((await e.call('POST','/admin/operations/expenses',e.sa.id,{amount:-5})).status,400);
 let r=await e.call('PUT','/admin/operations/content/about',e.sa.id,{body:'draft synthetic',version:0,action:'DRAFT',reason:'QA'});assert.equal(r.status,200,JSON.stringify(r.json));
 assert.equal((await e.call('GET','/public/content/about')).json.data.published,null);
 r=await e.call('PUT','/admin/operations/content/about',e.sa.id,{body:'published synthetic',version:1,action:'PUBLISH',reason:'QA'});assert.equal(r.status,200);
 const pub=(await e.call('GET','/public/content/about')).json.data;assert.equal(pub.published,'published synthetic');assert.equal(pub.draft,undefined);assert.equal(pub.updatedById,undefined);
 assert.equal((await e.call('PUT','/admin/operations/content/about',e.sa.id,{body:'stale',version:1,action:'DRAFT',reason:'QA'})).status,409);
 assert.equal((await e.call('PUT','/admin/operations/content/terms',e.sa.id,{body:'actual terms text',version:0,action:'PUBLISH',reason:'QA'})).status,200);
 assert.equal((await e.prisma.platformSetting.findUnique({where:{key:'termsContent'}})).value,'actual terms text');
 await e.call('PUT','/admin/operations/content/about',e.sa.id,{body:'published synthetic',version:2,action:'UNPUBLISH',reason:'QA'});
 assert.equal((await e.call('GET','/public/content/about')).json.data.published,null);
});

test('broadcast preview does not send; confirmed snapshot, concurrent workers, one inbox row; cancellation preserves inbox',opts,async()=>{
 const e=await env();const {draftBroadcast,previewBroadcast,sendBroadcast,processBroadcastBatch}=await import('./admin-communications.service');
 const user=await e.mkUser('CLIENT_INDIVIDUAL','broadcast');const banned=await e.mkUser('CLIENT_INDIVIDUAL','banned');await e.prisma.user.update({where:{id:banned.id},data:{isBanned:true}});
 const campaign=await draftBroadcast(e.sa.id,{requestKey:randomUUID(),title:'synthetic announcement',message:'test only',audience:'CLIENT'});
 const p=await previewBroadcast(campaign.id);assert.ok(p.recipients>0);assert.equal(await e.prisma.notification.count({where:{type:'ADMIN_BROADCAST'}}),0);
 await assert.rejects(()=>sendBroadcast(e.sa.id,campaign.id,1,p.recipients+1),/تغير عدد/);
 await sendBroadcast(e.sa.id,campaign.id,1,p.recipients);await Promise.all([processBroadcastBatch(),processBroadcastBatch()]);await processBroadcastBatch();
 assert.equal(await e.prisma.notification.count({where:{userId:user.id,type:'ADMIN_BROADCAST'}}),1);assert.equal(await e.prisma.notification.count({where:{userId:banned.id,type:'ADMIN_BROADCAST'}}),0);
 const sent=await e.prisma.adminBroadcast.findUnique({where:{id:campaign.id}});assert.equal(sent.status,'COMPLETED');assert.equal(sent.sentCount,p.recipients);
 const cancel=await draftBroadcast(e.sa.id,{requestKey:randomUUID(),title:'cancel',message:'no send',audience:'ALL'});await sendBroadcast(e.sa.id,cancel.id,1,0,true);await processBroadcastBatch();assert.equal(await e.prisma.adminBroadcastDelivery.count({where:{broadcastId:cancel.id}}),0);
});

test('cashback completion creates pending entitlement, audited score awaits real review then credits exactly once, snapshot unchanged',opts,async()=>{
 const e=await env();const {accrueCashbackForDeliveryCompletion}=await import('./cashback.service');const {processCashback}=await import('./cashback-review.service');
 const {notificationService}=await import('./notification.service');notificationService.createAndEmit=async()=>({}) as any;
 const client=await e.mkUser('CLIENT_INDIVIDUAL','cbclient'), provider=await e.mkUser('PROVIDER_INDIVIDUAL','cbprovider');
 const project=await e.prisma.project.create({data:{title:'cashback QA',description:'synthetic',specialty:'x',deliveryDays:2,clientId:client.id,status:'COMPLETED'}});
 const contract=await e.prisma.contract.create({data:{projectId:project.id,clientId:client.id,providerId:provider.id,price:3000,durationDays:2,phasesCount:1,status:'COMPLETED'}});
 await e.prisma.escrow.create({data:{projectId:project.id,amount:3000,releasedAmount:3000,status:'RELEASED'}});
 const old={enabled:process.env.CASHBACK_ENGINE_ENABLED,timing:process.env.CASHBACK_WALLET_TIMING};process.env.CASHBACK_ENGINE_ENABLED='true';process.env.CASHBACK_WALLET_TIMING='IMMEDIATE';
 try {
 const pending=await e.prisma.$transaction((tx:any)=>accrueCashbackForDeliveryCompletion(tx,contract));assert.equal(pending.status,'PENDING');
 let review=await e.prisma.cashbackReview.findUnique({where:{contractId:contract.id}});assert.equal(Number(review.eligibleValue),3000);
 const waiting=await processCashback(contract.id,{id:e.sa.id,score:80,note:'recorded payment score',version:review.version});assert.equal(waiting.status,'PENDING');
 review=await e.prisma.cashbackReview.findUnique({where:{contractId:contract.id}});assert.equal(review.status,'WAITING_RATING');assert.equal(await e.prisma.clientCashbackEntry.count({where:{contractId:contract.id}}),0);
 await e.prisma.review.create({data:{clientId:client.id,providerId:provider.id,projectId:project.id,reviewerRole:'PROVIDER',rating:4.8,tags:[]}});
 const twins=await Promise.all([processCashback(contract.id),processCashback(contract.id)]);assert.equal(twins.filter(r=>r.status==='CREDITED').length,1);
 const entry=await e.prisma.clientCashbackEntry.findUnique({where:{contractId:contract.id}});assert.equal(entry.amount,39.6);assert.equal(entry.ratingInput,4.8);assert.equal(entry.paymentInput,80);
 assert.equal(Number((await e.prisma.user.findUnique({where:{id:client.id}})).walletBalance),39.6);assert.equal(await e.prisma.walletTransaction.count({where:{referenceId:`CASHBACK-${contract.id}`}}),1);
 } finally {if(old.enabled===undefined)delete process.env.CASHBACK_ENGINE_ENABLED;else process.env.CASHBACK_ENGINE_ENABLED=old.enabled;if(old.timing===undefined)delete process.env.CASHBACK_WALLET_TIMING;else process.env.CASHBACK_WALLET_TIMING=old.timing;}
});

test('future receivables use actual undelivered stages; leadership roster includes system managers without staff placement',opts,async()=>{
 const e=await env();const {operatingFinance}=await import('./admin-operating-finance.service');const {AdminStaffService}=await import('./admin-staff.service');
 const client=await e.mkUser('CLIENT_INDIVIDUAL','futureclient'),provider=await e.mkUser('PROVIDER_INDIVIDUAL','futureprovider');
 const p=await e.prisma.project.create({data:{title:'upcoming QA',description:'synthetic',specialty:'x',deliveryDays:3,clientId:client.id,status:'IN_PROGRESS'}});
 const c=await e.prisma.contract.create({data:{projectId:p.id,clientId:client.id,providerId:provider.id,price:100,durationDays:3,phasesCount:1,status:'ACTIVE'}});
 const s=await e.prisma.projectStage.create({data:{contractId:c.id,stepOrder:1,title:'actual stage',days:3,percentage:100,amount:100,status:'IN_PROGRESS',startedAt:new Date('2026-11-01T00:00:00Z')}});
 let rows=await operatingFinance.upcoming();const row=rows.rows.find(r=>r.id===s.id)!;assert.equal(row.amount,100);assert.equal(row.dueAt?.toISOString(),'2026-11-04T00:00:00.000Z');
 await e.prisma.stageDelivery.create({data:{stageId:s.id,providerId:provider.id,note:'delivered'}});rows=await operatingFinance.upcoming();assert.ok(!rows.rows.some(r=>r.id===s.id),'delivered stages leave the future list');
 const roster=await new AdminStaffService().list({});assert.ok(roster.leadership.some(u=>u.userId===e.sa.id));assert.ok(!roster.members.some(u=>u.userId===e.sa.id));
 await assert.rejects(()=>new AdminStaffService().setRole(e.sa.id,e.sa.id,null,1),/Super Admin/);
});
