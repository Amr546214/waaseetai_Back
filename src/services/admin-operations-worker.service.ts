import {loginGuardService} from './login-guard.service';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { processBroadcastBatch } from './admin-communications.service';
import { processCashback } from './cashback-review.service';
import { cashbackGate } from '../config/cashback-policy';
let busy=false;
export async function runAdminOperationsWorker() {
 if(busy)return;busy=true;
 try {
  await loginGuardService.cleanup();
  await processBroadcastBatch();
  if(!cashbackGate()) {
   const pending=await prisma.cashbackReview.findMany({where:{status:'WAITING_RATING',paymentInput:{not:null}},orderBy:{updatedAt:'asc'},take:30});
   for(const p of pending) { try { await processCashback(p.contractId); } catch(e) { logger.error(`[cashback] pending review ${p.id} failed: ${e instanceof Error?e.message:'unknown'}`); } }
  }
 } finally {busy=false;}
}
export function startAdminOperationsWorker() {
 const tick=()=>void runAdminOperationsWorker().catch(e=>logger.error(`[admin-operations] worker failed: ${e instanceof Error?e.message:'unknown'}`));
 const timer=setInterval(tick,30000);timer.unref();tick();return timer;
}
