import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { env,opts,mkStaff,closeEnv } from '../testing/admin-team.pgenv';
after(closeEnv);
test('sidebar counts are actual unresolved work and are scoped to the caller permissions',opts,async()=>{
 const e=await env();
 const support=await mkStaff(e,['support.review']);
 assert.equal((await e.call('GET','/admin/team/sidebar-counts')).status,401);
 const scoped=await e.call('GET','/admin/team/sidebar-counts',support.user.id);
 assert.equal(scoped.status,200);assert.equal(scoped.json.data.disputes,0);assert.equal(scoped.json.data.reports,0);assert.equal(scoped.json.data.modifications,0);
 assert.equal(scoped.json.data.total,await e.prisma.supportTicket.count({where:{status:{in:['OPEN','IN_PROGRESS','AWAITING_CUSTOMER']}}}));
 const all=await e.call('GET','/admin/team/sidebar-counts',e.sa.id);
 assert.equal(all.status,200);assert.equal(all.json.data.total,all.json.data.disputes+all.json.data.reports+all.json.data.support+all.json.data.modifications);
});
