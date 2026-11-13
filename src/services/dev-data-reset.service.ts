import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { systemSettingsService } from './system-settings.service';
import { adminAudit } from './admin-audit.service';
import { publishSettingsChange } from './settings-bus';

// Explicit application table inventory. Unknown tables stop the reset; no CASCADE, schema reset or migration-registry writes.
const KNOWN = new Set<string>(["users", "user_sessions", "profile_change_requests", "profile_modification_requests", "client_profiles", "provider_profiles", "skills", "portfolio_items", "educations", "provider_gamification", "reviews", "point_transactions", "gamification_rules", "account_audit_logs", "certificates", "otp_verifications", "projects", "saved_projects", "saved_client_requests", "proposals", "ProposalAttachment", "escrows", "service_catalogs", "carts", "cart_items", "coupons", "coupon_services", "orders", "coupon_redemptions", "special_offers", "special_offer_redemptions", "order_items", "marketplace_favorites", "service_stages", "categories", "specialties", "provider_specialties", "questions", "work_samples", "proof_attachments", "ai_audit_logs", "project_proposals", "proposal_milestones", "notifications", "notification_preferences", "support_tickets", "support_ticket_messages", "conversations", "messages", "affiliate_profiles", "affiliate_channel_handles", "referrals", "commission_logs", "affiliate_channel_metrics", "referral_custom_links", "provider_skill_assessments", "contracts", "project_amendments", "contract_terms_versions", "project_stages", "stage_deliveries", "accreditation_samples", "provider_accreditation_submissions", "provider_accreditation_proofs", "provider_accreditation_audit_logs", "assessment_attempts", "disputes", "withdrawals", "payout_attempts", "paypal_webhook_events", "identity_field_checks", "client_onboarding", "client_requests", "wallet_transactions", "paypal_payments", "newsletter_subscribers", "company_team_members", "platform_settings", "marketing_assets", "rate_limit_counters", "accreditation_sample_events", "accreditation_proof_uploads", "chat_digest_state", "chat_digest_activation", "admin_roles", "admin_staff", "admin_invites", "admin_tasks", "admin_task_events", "admin_access_audit", "admin_staff_overrides", "admin_conversations", "admin_conversation_members", "admin_messages", "fee_policy_versions", "site_identity_assets", "site_identity_state", "site_identity_manifest", "case_attachments", "registration_email_proofs", "contract_cancellation_requests", "dispute_messages", "platform_reports", "notification_templates", "admin_saved_reports", "admin_action_idempotency", "engagement_closures", "client_cashback_entries", "admin_expenses", "admin_content_pages", "admin_broadcasts", "admin_broadcast_deliveries", "cashback_reviews", "exam_ticket_uses", "_ProviderProfileToSkill", "login_guard_state", "login_guard_attempts"]);
const KEEP = new Set(['users','user_sessions','account_audit_logs','admin_roles','admin_staff','admin_staff_overrides','admin_access_audit','admin_action_idempotency','platform_settings','categories','specialties','skills','questions','gamification_rules','fee_policy_versions','marketing_assets','site_identity_assets','site_identity_state','site_identity_manifest','notification_templates','admin_content_pages','login_guard_state','login_guard_attempts','_prisma_migrations']);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const quote = (n: string) => '"' + n.replaceAll('"','""') + '"';
const keptUsers = { OR: [{accountType:{in:['ADMIN','SUPER_ADMIN'] as ('ADMIN'|'SUPER_ADMIN')[]}},{adminStaff:{isNot:null}}] };
export const RESET_CONFIRMATION = 'امسح بيانات dev';
export async function devResetCapability() {
 const rows = await prisma.$queryRaw<Array<{name:string}>>`SELECT current_database() AS name`;
 const database = rows[0]?.name ?? '';
 let host = ''; try { host = new URL(process.env.FRONTEND_URL || '').hostname; } catch {}
 const allowed = process.env.PLATFORM_DEPLOY_ENV !== 'official' && host === 'dev.waseetai.com' && !!process.env.DEV_RESET_DATABASE_NAME && database === process.env.DEV_RESET_DATABASE_NAME;
 return { allowed, database, reason: allowed ? '' : 'المسح على dev فقط: يجب تثبيت اسم قاعدة dev في DEV_RESET_DATABASE_NAME وتطابق FRONTEND_URL مع dev.waseetai.com.', confirmation: RESET_CONFIRMATION };
}
async function guard() {
 const cap = await devResetCapability();
 if (!cap.allowed) throw new AppError(cap.reason,403);
 if (!(await systemSettingsService.get<boolean>('maintenanceMode'))) throw new AppError('فعّل الصيانة أولاً قبل معاينة ومسح بيانات dev.',409);
 return cap;
}
async function plan(tx: Prisma.TransactionClient) {
 const tables = (await tx.$queryRaw<Array<{name:string}>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`).map(t=>t.name);
 const unknown = tables.filter(t=>!KNOWN.has(t)&&!KEEP.has(t));
 if (unknown.length) throw new AppError('توجد جداول خارج خطة المسح؛ تحتاج مراجعة الخادم: '+unknown.join(', '),409);
 const wipe = tables.filter(t=>!KEEP.has(t));
 const dependencies = await tx.$queryRaw<Array<{child:string;parent:string}>>`SELECT c.relname AS child,p.relname AS parent FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE f.contype='f' AND n.nspname='public'`;
 if (dependencies.some(f=>wipe.includes(f.parent)&&!wipe.includes(f.child))) throw new AppError('ارتباط جديد ببيانات محفوظة؛ أُوقف المسح لحين مراجعة الخطة.',409);
 const protectedIds = (await tx.user.findMany({where:keptUsers,select:{id:true},orderBy:{id:'asc'}})).map(u=>u.id);
 const userCount = await tx.user.count({where:{id:{notIn:protectedIds}}});
 const counts: {table:string;rows:number}[] = [];
 for (const table of wipe) {
  const r = await tx.$queryRawUnsafe<Array<{n:bigint}>>('SELECT count(*) AS n FROM public.'+quote(table));
  counts.push({table,rows:Number(r[0].n)});
 }
 return { tables: counts, usersToDelete:userCount, adminsRetained:protectedIds.length, protectedIds, retained:[...KEEP].sort() };
}
export async function previewDevReset(actor:string) {
 const cap = await guard();
 return prisma.$transaction(async tx=>{
  const p = await plan(tx); const token = randomUUID(); const expiresAt = Date.now()+300000;
  await tx.adminActionIdempotency.create({data:{adminId:actor,key:token,action:'DEV_RESET_PREVIEW',entityType:'SYSTEM',entityId:cap.database,requestHash:hash(p),response:{expiresAt,used:false}}});
  const {protectedIds,...shown}=p;
  return {...shown,token,expiresAt,database:cap.database,confirmation:RESET_CONFIRMATION};
 },{timeout:30000,isolationLevel:'RepeatableRead'});
}
export async function executeDevReset(actor:string,body:{token:string;confirmation:string;reason:string;backupConfirmed:boolean}) {
 const cap = await guard();
 if(!body.backupConfirmed||body.confirmation!==RESET_CONFIRMATION || body.reason.trim().length<5) throw new AppError('اكتب عبارة التأكيد وسبب المسح.',400);
 const result = await prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('waseet-dev-data-reset'))`;
  const preview = await tx.adminActionIdempotency.findUnique({where:{adminId_key:{adminId:actor,key:body.token}}});
  const receipt=preview?.response as {used?:boolean;expiresAt?:number}|undefined;
  if(!preview||preview.action!=='DEV_RESET_PREVIEW'||preview.entityId!==cap.database||receipt?.used||!receipt?.expiresAt||receipt.expiresAt<Date.now()) throw new AppError('المعاينة انتهت أو استُخدمت. أعد المعاينة.',409);
  // Prevent writes while validating the preview and clearing the explicit table set.
  const p = await plan(tx);
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  await tx.$executeRawUnsafe('LOCK TABLE '+['users','admin_staff','platform_settings','admin_broadcasts','admin_broadcast_deliveries',...p.tables.map(t=>t.table)].filter((v,i,a)=>a.indexOf(v)===i).sort().map(n=>'public.'+quote(n)).join(', ')+' IN ACCESS EXCLUSIVE MODE');
  if(hash(await plan(tx))!==preview.requestHash) throw new AppError('تغيّرت بيانات dev بعد المعاينة؛ أعد المعاينة والتأكيد.',409);
  const maintenance=await tx.platformSetting.findUnique({where:{key:'maintenanceMode'}});
  if(maintenance?.value!==true) throw new AppError('يجب أن تبقى الصيانة مفعلة أثناء المسح.',409);
  if(await tx.adminBroadcast.count({where:{status:'SENDING'}}) || await tx.adminBroadcastDelivery.count({where:{emailStatus:'SENDING'}})) throw new AppError('ألغِ الإرسال الجاري وانتظر انتهاء الرسائل قيد المعالجة قبل المسح.',409);
  const payouts=await tx.$queryRaw<Array<{n:bigint}>>`SELECT count(*) AS n FROM payout_attempts WHERE status::text IN ('PENDING','SUBMITTING','UNKNOWN','PROCESSING','CREATED')`;
  const held=await tx.escrow.count({where:{status:'HELD',amount:{gt:0}}});
  if(held) throw new AppError('توجد ضمانات محتجزة؛ سوِّها قبل مسح بيانات dev.',409);
  if(Number(payouts[0]?.n)>0) throw new AppError('توجد عمليات صرف غير محسومة؛ راجعها قبل المسح.',409);
  if(p.tables.length) await tx.$executeRawUnsafe('TRUNCATE TABLE '+p.tables.map(t=>'public.'+quote(t.table)).join(', '));
  await tx.user.deleteMany({where:{id:{notIn:p.protectedIds}}});
  await tx.user.updateMany({where:{id:{in:p.protectedIds}},data:{walletBalance:0,totalGmvAmount:0,completedProjectsCount:0}});
  await tx.adminActionIdempotency.update({where:{id:preview.id},data:{response:{used:true,at:new Date().toISOString()}}});
  await adminAudit.recordTx(tx,{adminId:actor,entity:'FINANCE',entityId:cap.database,eventType:'DEV_DATA_RESET',title:'مسح بيانات dev',summary:'حذف بيانات التشغيل التجريبية مع حفظ الإدارة والإعدادات',severity:'CRITICAL',details:{reason:body.reason,counts:p.tables,usersDeleted:p.usersToDelete}});
  return {cleared:true,usersDeleted:p.usersToDelete,tables:p.tables.length};
 },{timeout:60000,maxWait:10000});
 await publishSettingsChange(['taxonomy']);
 return result;
}
