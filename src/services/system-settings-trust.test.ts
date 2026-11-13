import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SystemSettingsService} from './system-settings.service';
test('a missing table after warm-up preserves last known settings and revision; cold boot remains untrusted',async()=>{
 let missing=false;const svc=new SystemSettingsService({platformSetting:{findMany:async()=>{if(missing)throw{code:'P2021'};return[{key:'maintenanceMode',value:true,version:1},{key:'maintenanceBannerText',value:'known maintenance',version:1},{key:'__platform_public_revision',value:0,version:9}];}}} as any);
 assert.equal(await svc.prime(),true);assert.equal((await svc.publicSnapshot()).revision,9);missing=true;svc.invalidate();
 assert.deepEqual(await svc.getTrusted('maintenanceMode'),{value:true,trusted:true,stale:true});const last=await svc.publicSnapshot();assert.equal(last.trusted,true);assert.equal(last.data.maintenanceMode,true);assert.equal(last.data.maintenanceBannerText,'known maintenance');assert.equal(last.revision,9);
 const cold=new SystemSettingsService({platformSetting:{findMany:async()=>{throw{code:'P2021'};}}} as any);assert.equal(await cold.prime(),false);assert.equal((await cold.getTrusted('maintenanceMode')).trusted,false);assert.equal((await cold.publicSnapshot()).trusted,false);
});
