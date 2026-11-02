import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { SETTING_BY_KEY } from '../config/system-settings.registry';
import { ACCESS_ACTION_CODES, AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, SELF_ACTED_CODES, auditActionLabel } from '../utils/audit-trail-labels';
import { ALL_CLASSIFIED_CODES, codesOf, effectiveSeverity } from '../utils/audit-trail-classification';
import { metaFacts, redact } from '../utils/audit-detail-sanitizer';
import { identityDef } from '../config/site-identity.registry';

/**
 * The admin audit trail: ONE list over the two places that really record administrative events
 *  - account_audit_logs (sessions, settings, fee policy, back-office actions, KYC, finance ...), and
 *  - admin_access_audit (roles, invitations, staff access).
 * Identity: an event's stable identity is its real row id prefixed with its table: `LOG:<id>` / `ACCESS:<id>` (`id` = `eventId`). There is NO event number:
 * the «#» column of the screen is only the display order of the current result.
 * Order (deterministic, also under identical timestamps): createdAt desc, then source ('ACCESS' before 'LOG'), then id desc. Each table is read in the
 * order createdAt desc, id desc (the database decides the id order, so it is the same on every read) and the two are merged by time then source with a stable
 * sort, so every page is stable.
 * No duplicates: admin_access_audit is the system of record for its action codes (ACCESS_ACTION_CODES). An account_audit_logs row that carries one of those
 * codes is a mirror of the same action and is excluded at query level (list, count and the type list), so the same action never appears twice.
 *
 * WHO is the actor (only what is stored proves it; otherwise «غير معروف»):
 *   1. actorLabel «ADMIN:<id>» / «SUPER_ADMIN:<id>» / a bare id (back-office rows written on the AFFECTED account, adminAuditData / human-review rows);
 *   2. metaData.adminId / reviewerUserId / viewerUserId / appliedById (rows that keep the acting admin in their metadata);
 *   3. source ADMIN with context.entity (adminAudit.record: the row belongs to the admin who acted);
 *   4. source ADMIN with actorLabel exactly «ADMIN» (settings / fee policy / recordAdminAudit: the row belongs to the admin who acted);
 *   5. a code the person does on their OWN account (SELF_ACTED_CODES) with source USER: the owner of the row;
 *   6. source SYSTEM / AI: the system / the AI;
 *   otherwise unknown (e.g. LOGIN_REJECTED: nobody proves who typed the wrong password).
 */

const ADMIN_TYPES = ['ADMIN', 'SUPER_ADMIN'] as const;
const FETCH_CAP = 5000;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ACTOR_LABEL = /^(?:(?:ADMIN|SUPER_ADMIN):)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** metadata keys that, when they hold a user id, prove who acted */
const ACTOR_META_KEYS = ['adminId', 'reviewerUserId', 'viewerUserId', 'appliedById'] as const;
/** codes whose row is written on the ACTING admin by a writer that does not set a context entity (settings, fee policy) */
const OWNER_ACTS_CODES = ['PLATFORM_SETTINGS_UPDATED', 'FEE_POLICY_SCHEDULED', 'FEE_POLICY_CANCELLED', 'SITE_IDENTITY_UPLOADED', 'SITE_IDENTITY_PUBLISHED', 'SITE_IDENTITY_RESTORED', 'SITE_IDENTITY_SET_RESTORED', 'SITE_IDENTITY_DISCARDED'];

export interface AuditTrailQuery {
	page?: unknown; limit?: unknown; q?: string; eventType?: string; severity?: string; source?: string;
	actorId?: string; from?: string; to?: string; scope?: string;
}
export type ActorKind = 'USER' | 'SYSTEM' | 'AI' | 'UNKNOWN';
export interface Actor { id: string | null; name: string; accountType: string | null; kind: ActorKind }
interface Who { id: string; name: string; accountType: string | null }
interface Target { type: string; typeLabel: string; id: string | null; label: string | null }

const boundedInt = (v: unknown, fallback: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const code = (v: string) => String(v).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

type LogLike = { userId: string; eventType?: string | null; source?: string | null; actorLabel?: string | null; metaData?: unknown; context?: unknown };

/** WHO acted on an account_audit_logs row: a proven user id, the system / AI, or unknown (see the file comment for the rules) */
export function actorOfLog(r: LogLike): { id: string | null; kind: ActorKind } {
	const label = ACTOR_LABEL.exec(r.actorLabel ?? '');
	if (label) return { id: label[1], kind: 'USER' };
	const meta = obj(r.metaData);
	for (const k of ACTOR_META_KEYS) { const v = str(meta[k]); if (v && UUID_RE.test(v)) return { id: v, kind: 'USER' }; }
	const code0 = r.eventType ?? '';
	if (r.source === 'ADMIN') {
		if (str(obj(r.context).entity)) return { id: r.userId, kind: 'USER' };
		if (r.actorLabel === 'ADMIN' || OWNER_ACTS_CODES.includes(code0)) return { id: r.userId, kind: 'USER' };
	}
	if ((r.source === 'USER' || !r.source) && SELF_ACTED_CODES.includes(code0)) return { id: r.userId, kind: 'USER' };
	if (r.source === 'SYSTEM') return { id: null, kind: 'SYSTEM' };
	if (r.source === 'AI') return { id: null, kind: 'AI' };
	return { id: null, kind: 'UNKNOWN' };
}

/** prisma conditions for «this account is the proven actor» on account_audit_logs rows: the exact inverse of actorOfLog for a user id */
function actorWhere(id: string): Prisma.AccountAuditLogWhereInput {
	return {
		OR: [
			{ actorLabel: { endsWith: id } },
			...ACTOR_META_KEYS.map(k => ({ metaData: { path: [k], equals: id } }) as Prisma.AccountAuditLogWhereInput),
			{ AND: [{ userId: id }, { source: 'ADMIN' }, { OR: [{ actorLabel: 'ADMIN' }, { eventType: { in: OWNER_ACTS_CODES } }, { context: { path: ['entity'], string_contains: '' } }] }] },
			{ AND: [{ userId: id }, { eventType: { in: SELF_ACTED_CODES } }, { OR: [{ source: 'USER' }, { source: null }] }] }
		]
	};
}

const STATUS_AR: Record<string, string> = { ACTIVE: 'نشط', SUSPENDED: 'موقوف' };

/** pure: the short factual detail of an access-trail row (names / counts from before / after only) */
export function accessDetail(a: { action: string; before?: unknown; after?: unknown }, roleName: (id: unknown) => string | null): string | null {
	const b = obj(a.before), f = obj(a.after);
	const q = (v: unknown) => redact(v, 80);
	let out: string | null;
	switch (a.action) {
		case 'ROLE_CREATED': out = `الدور «${q(str(f.name) ?? '—')}» بـ ${arr(f.permissions).length} صلاحية`; break;
		case 'ROLE_UPDATED': {
			const parts: string[] = [];
			if (str(b.name) && str(f.name) && b.name !== f.name) parts.push(`الاسم من «${q(b.name)}» إلى «${q(f.name)}»`);
			else parts.push(`الدور «${q(str(f.name) ?? str(b.name) ?? '—')}»`);
			parts.push(`أُضيفت ${arr(f.permissionsAdded).length} وأُزيلت ${arr(f.permissionsRemoved).length} صلاحية`);
			const members = arr(f.affectedMembers).length; if (members) parts.push(`يمسّ ${members} موظفًا`);
			out = parts.join(' · '); break;
		}
		case 'INVITE_CREATED': case 'INVITE_ACCEPTED': out = `بالدور «${q(roleName(f.roleId) ?? '—')}»`; break;
		case 'STAFF_ATTACHED': out = `بالدور «${q(roleName(f.roleId) ?? 'بلا دور')}»`; break;
		case 'STAFF_ROLE_SET': out = `من «${q(roleName(b.roleId) ?? 'بلا دور')}» إلى «${q(roleName(f.roleId) ?? 'بلا دور')}»`; break;
		case 'STAFF_SUSPENDED': case 'STAFF_REACTIVATED': out = `الحالة: ${STATUS_AR[String(b.status)] ?? str(b.status) ?? '—'} ← ${STATUS_AR[String(f.status)] ?? str(f.status) ?? '—'}`; break;
		case 'STAFF_ACCESS_SET': out = `${arr(f.overrides).length} استثناء شخصي · النطاق ${f.scoped ? 'مقيّد بأقسام' : 'كامل'}`; break;
		case 'STAFF_ACCESS_RESET': out = 'أُزيلت الاستثناءات الشخصية'; break;
		default: out = null;
	}
	return out;
}

/** pure: the short factual detail of an account_audit_logs row. Known codes are built from allow-listed metadata; everything printed is redacted */
export function logDetail(r: { eventType: string; summary?: string | null; actionText?: string | null; metaData?: unknown; afterData?: unknown }): { detail: string | null; detailDate: string | null } {
	const m = obj(r.metaData);
	const fallback = redact(str(r.summary) ?? str(r.actionText) ?? metaFacts(m) ?? '') || null;
	switch (r.eventType) {
		case 'PLATFORM_SETTINGS_UPDATED': {
			const keys = arr(m.keys).filter((k): k is string => typeof k === 'string');
			if (keys.length) return { detail: `الإعدادات: ${keys.map(k => redact(SETTING_BY_KEY.get(k)?.label ?? k, 60)).join('، ')}`, detailDate: null };
			return { detail: fallback, detailDate: null };
		}
		case 'FEE_POLICY_SCHEDULED': {
			const n = Object.keys(obj(r.afterData)).length;
			return { detail: `نسخة ${redact(m.version ?? '—', 10)}${n ? ` · ${n} تغيير` : ''} · تسري من`, detailDate: str(m.effectiveFrom) };
		}
		case 'SITE_IDENTITY_UPLOADED': return { detail: `${identityLabel(m.identityKey)} · مسودة نسخة ${redact(m.version ?? '—', 10)}${str(m.sha) ? ` · ${redact(m.sha, 16)}` : ''}`, detailDate: null };
		case 'SITE_IDENTITY_DISCARDED': return { detail: `${identityLabel(m.identityKey)} · مسودة نسخة ${redact(m.version ?? '—', 10)}`, detailDate: null };
		case 'SITE_IDENTITY_PUBLISHED': case 'SITE_IDENTITY_RESTORED': return { detail: `${identityLabel(m.identityKey)} · ${m.fromVersion ? `نسخة ${redact(m.fromVersion, 10)}` : 'الافتراضي'} ← ${m.toVersion ? `نسخة ${redact(m.toVersion, 10)}` : 'الافتراضي'}`, detailDate: null };
		case 'SITE_IDENTITY_SET_RESTORED': return { detail: `${str(m.target) ? redact(m.target, 40) : 'مجموعة سابقة'} · ${String(str(m.identityKey) ?? '').split(',').filter(Boolean).length} عنصر`, detailDate: null };
		case 'FEE_POLICY_CANCELLED': return { detail: `النسخة المجدولة ${redact(m.version ?? '—', 10)}`, detailDate: null };
		default: return { detail: fallback, detailDate: null };
	}
}

/** the entity an account_audit_logs row is about, when it has one (verified per writer: see AUDIT-TRAIL-CLASSIFICATION doc) */
export function logTarget(r: LogLike & { userId: string }, actor: { id: string | null; kind: ActorKind }, users: Map<string, Who>): Target | null {
	const ctx = obj(r.context), m = obj(r.metaData), c = r.eventType ?? '';
	const user = (id: string): Target => ({ type: 'USER', typeLabel: AUDIT_ENTITY_LABELS.USER, id, label: users.get(id)?.name || null });
	const entity = str(ctx.entity);
	if (entity) return { type: entity, typeLabel: AUDIT_ENTITY_LABELS[entity] ?? entity, id: str(ctx.entityId), label: null };
	if (c === 'PLATFORM_SETTINGS_UPDATED') return { type: 'SETTINGS', typeLabel: AUDIT_ENTITY_LABELS.SETTINGS, id: null, label: 'إعدادات المنصة' };
	if (c.startsWith('FEE_POLICY_')) return { type: 'FEE_POLICY', typeLabel: AUDIT_ENTITY_LABELS.FEE_POLICY, id: m.version != null ? String(m.version) : null, label: m.version != null ? `نسخة ${redact(m.version, 10)}` : null };
	if (c.startsWith('SITE_IDENTITY_')) { const k = str(m.identityKey); const one = k && !k.includes(','); return { type: 'SITE_IDENTITY', typeLabel: AUDIT_ENTITY_LABELS.SITE_IDENTITY, id: one ? k : null, label: one ? identityLabel(k) : 'مجموعة هوية الموقع' }; }
	if (c === 'USER_DELETED_BY_ADMIN') { const d = str(m.deletedUserId); return d ? { type: 'USER', typeLabel: AUDIT_ENTITY_LABELS.USER, id: d, label: null } : null; }
	if (c.startsWith('COUPON_ADMIN_')) { const id = str(m.couponId); return id ? { type: 'COUPON', typeLabel: AUDIT_ENTITY_LABELS.COUPON, id, label: str(m.code) ? redact(m.code, 40) : null } : null; }
	if (c === 'AMENDMENT_APPLIED' || c === 'STAGE_FUND_RELEASED') { const id = str(m.contractId); return id ? { type: 'CONTRACT', typeLabel: AUDIT_ENTITY_LABELS.CONTRACT, id, label: null } : null; }
	if (c === 'LOGIN_REJECTED') return user(r.userId); // nobody proves who tried: the affected account is the target
	if (actor.id && actor.id !== r.userId) return user(r.userId); // an admin acting on the affected account
	return null;
}

/** the Arabic name of an identity key (the key itself when it is not in the registry) */
const identityLabel = (k: unknown): string => { const key = str(k); return key ? redact(identityDef(key)?.label ?? key, 60) : 'هوية الموقع'; };

const sourceRank = (k: 'LOG' | 'ACCESS') => (k === 'ACCESS' ? 0 : 1);

export async function listAuditTrail(query: AuditTrailQuery, db: any = prisma) {
	const limit = boundedInt(query.limit, 20, 1, 100);
	const maxPage = Math.max(1, Math.floor(FETCH_CAP / limit));
	const page = boundedInt(query.page, 1, 1, maxPage);
	const adminScope = query.scope !== 'all';
	const sourceFilter = query.source && ['USER', 'AI', 'ADMIN', 'SYSTEM'].includes(query.source) ? query.source : null;
	const severity = query.severity && ['INFO', 'WARNING', 'CRITICAL', 'UNCLASSIFIED'].includes(query.severity) ? query.severity : null;
	const eventType = query.eventType ? code(query.eventType) : null;
	const range: { gte?: Date; lte?: Date } = {};
	if (query.from && !Number.isNaN(Date.parse(query.from))) range.gte = new Date(query.from);
	if (query.to && !Number.isNaN(Date.parse(query.to))) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); range.lte = end; }
	const hasRange = Boolean(range.gte || range.lte);
	const text = query.q ? String(query.q).trim().slice(0, 80) : '';

	let matchUserIds: string[] = [];
	let matchCodes: string[] = [];
	if (text) {
		const words = text.split(/\s+/).filter(Boolean).slice(0, 3);
		const found = await db.user.findMany({ where: { AND: words.map(w => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' } }, { lastName: { contains: w, mode: 'insensitive' } }] })) }, select: { id: true }, take: 50 });
		matchUserIds = found.map((u: any) => u.id);
		matchCodes = Object.entries(AUDIT_ACTION_LABELS).filter(([, label]) => label.includes(text)).map(([c]) => c);
	}

	// severity -> code lists (the class table) + the stored severity of the row
	const classified = ALL_CLASSIFIED_CODES;
	const logSeverity = (): Prisma.AccountAuditLogWhereInput | null => {
		if (!severity) return null;
		if (severity === 'CRITICAL') return { OR: [{ severity: 'CRITICAL' }, { eventType: { in: codesOf('CRITICAL') } }] };
		if (severity === 'WARNING') return { AND: [{ OR: [{ severity: 'WARNING' }, { eventType: { in: codesOf('WARNING') } }] }, { OR: [{ severity: null }, { severity: { not: 'CRITICAL' } }] }, { eventType: { notIn: codesOf('CRITICAL') } }] };
		if (severity === 'INFO') return { AND: [{ eventType: { in: codesOf('INFO') } }, { OR: [{ severity: null }, { severity: 'INFO' }] }] };
		return { AND: [{ OR: [{ eventType: null }, { eventType: { notIn: classified } }] }, { OR: [{ severity: null }, { severity: 'INFO' }] }] };
	};

	// --- account_audit_logs (rows that mirror an access-trail action are not listed: the access trail is their system of record) ---
	const and: Prisma.AccountAuditLogWhereInput[] = [{ OR: [{ eventType: null }, { eventType: { notIn: ACCESS_ACTION_CODES } }] }];
	if (adminScope) and.push({ OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] });
	if (query.actorId) and.push(actorWhere(String(query.actorId)));
	if (eventType) and.push({ eventType });
	const sevLog = logSeverity(); if (sevLog) and.push(sevLog);
	if (sourceFilter) and.push({ source: sourceFilter });
	if (text) and.push({ OR: [{ title: { contains: text, mode: 'insensitive' } }, { summary: { contains: text, mode: 'insensitive' } }, { eventType: { contains: text, mode: 'insensitive' } }, ...(matchCodes.length ? [{ eventType: { in: matchCodes } }] : []), ...(matchUserIds.length ? [{ userId: { in: matchUserIds } }] : [])] });
	if (hasRange) and.push({ occurredAt: range });
	const logWhere: Prisma.AccountAuditLogWhereInput = { AND: and };

	// --- admin_access_audit (administrative scope only; its events are always source ADMIN) ---
	const withAccess = adminScope && (!sourceFilter || sourceFilter === 'ADMIN');
	const aand: Prisma.AdminAccessAuditWhereInput[] = [];
	if (query.actorId) aand.push({ actorId: String(query.actorId) });
	if (eventType) aand.push({ action: eventType });
	if (severity) { const inSev = (s: string) => ACCESS_ACTION_CODES.filter(c0 => (codesOf(s as any).includes(c0))); aand.push(severity === 'UNCLASSIFIED' ? { action: { notIn: classified } } : { action: { in: inSev(severity) } }); }
	if (text) aand.push({ OR: [{ action: { contains: text.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || '__none__' } }, ...(matchCodes.length ? [{ action: { in: matchCodes } }] : []), ...(matchUserIds.length ? [{ actorId: { in: matchUserIds } }, { subjectUserId: { in: matchUserIds } }] : [])] });
	if (hasRange) aand.push({ at: range });
	const accessWhere: Prisma.AdminAccessAuditWhereInput = aand.length ? { AND: aand } : {};

	const need = Math.min(page * limit, FETCH_CAP);
	const [logRows, logTotal, accessRows, accessTotal, logKinds, accessKinds] = await Promise.all([
		db.accountAuditLog.findMany({
			where: logWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: need,
			select: { id: true, eventType: true, category: true, title: true, summary: true, actionText: true, severity: true, source: true, status: true, occurredAt: true, createdAt: true, ipAddress: true, device: true, actorLabel: true, userId: true, metaData: true, afterData: true, context: true, user: { select: { firstName: true, lastName: true, accountType: true } } }
		}),
		db.accountAuditLog.count({ where: logWhere }),
		withAccess ? db.adminAccessAudit.findMany({ where: accessWhere, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: need }) : Promise.resolve([]),
		withAccess ? db.adminAccessAudit.count({ where: accessWhere }) : Promise.resolve(0),
		db.accountAuditLog.groupBy({ by: ['eventType'], where: { AND: [{ OR: [{ eventType: null }, { eventType: { notIn: ACCESS_ACTION_CODES } }] }, ...(adminScope ? [{ OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] }] : [])] }, _count: { _all: true } }),
		adminScope ? db.adminAccessAudit.groupBy({ by: ['action'], _count: { _all: true } }) : Promise.resolve([])
	]);

	type Row = { at: Date; id: string; kind: 'LOG' | 'ACCESS'; raw: any };
	const merged: Row[] = [
		...logRows.map((raw: any) => ({ at: raw.createdAt as Date, id: raw.id as string, kind: 'LOG' as const, raw })),
		...accessRows.map((raw: any) => ({ at: raw.at as Date, id: raw.id as string, kind: 'ACCESS' as const, raw }))
	].sort((x, y) => (y.at.getTime() - x.at.getTime()) || (sourceRank(x.kind) - sourceRank(y.kind)));
	// rows of the same source keep the database order (createdAt desc, id desc: the sort is stable); only a tie BETWEEN the two sources is decided here
	const pageRows = merged.slice((page - 1) * limit, page * limit);

	const userIds = new Set<string>(); const roleIds = new Set<string>();
	for (const r of pageRows) {
		if (r.kind === 'LOG') { userIds.add(r.raw.userId); const a = actorOfLog(r.raw); if (a.id) userIds.add(a.id); }
		else {
			userIds.add(r.raw.actorId); if (r.raw.subjectUserId) userIds.add(r.raw.subjectUserId);
			for (const v of [r.raw.roleId, obj(r.raw.before).roleId, obj(r.raw.after).roleId]) if (typeof v === 'string') roleIds.add(v);
		}
	}
	const [userRows, roleRows] = await Promise.all([
		userIds.size ? db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, firstName: true, lastName: true, accountType: true } }) : [],
		roleIds.size ? db.adminRole.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, name: true } }) : []
	]);
	const users = new Map<string, Who>(userRows.map((u: any) => [u.id, { id: u.id, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), accountType: u.accountType ?? null }]));
	const roles = new Map<string, string>(roleRows.map((r: any) => [r.id, r.name]));
	const roleName = (id: unknown) => (typeof id === 'string' ? roles.get(id) ?? null : null);
	const actorOut = (a: { id: string | null; kind: ActorKind }): Actor => {
		if (a.kind === 'USER' && a.id) { const u = users.get(a.id); return { id: a.id, name: u?.name || 'حساب محذوف', accountType: u?.accountType ?? null, kind: 'USER' }; }
		return { id: null, name: a.kind === 'SYSTEM' ? 'النظام' : a.kind === 'AI' ? 'الذكاء الاصطناعي' : 'غير معروف', accountType: null, kind: a.kind };
	};

	const items = pageRows.map(({ kind, raw }) => {
		if (kind === 'LOG') {
			const eventTypeCode = raw.eventType || 'SYSTEM_EVENT';
			const actor = actorOfLog(raw);
			const { detail, detailDate } = logDetail({ eventType: eventTypeCode, summary: raw.summary, actionText: raw.actionText, metaData: raw.metaData, afterData: raw.afterData });
			const target = logTarget({ eventType: eventTypeCode, userId: raw.userId, source: raw.source, actorLabel: raw.actorLabel, metaData: raw.metaData, context: raw.context }, actor, users);
			const sev = effectiveSeverity(eventTypeCode, raw.severity);
			return {
				id: `LOG:${raw.id}`, eventId: `LOG:${raw.id}`, rowId: raw.id, origin: 'LOG' as const,
				eventType: eventTypeCode, action: eventTypeCode, actionLabel: auditActionLabel(eventTypeCode),
				category: raw.category, title: raw.title, summary: raw.summary ? redact(raw.summary) : raw.actionText ? redact(raw.actionText) : null, detail, detailDate,
				severity: sev.severity, severitySource: sev.source, source: raw.source || 'SYSTEM', status: raw.status, occurredAt: raw.occurredAt ?? raw.createdAt, createdAt: raw.createdAt,
				ipAddress: raw.ipAddress, device: raw.device, actorLabel: null,
				actor: actorOut(actor), target,
				account: { id: raw.userId, name: `${raw.user?.firstName ?? ''} ${raw.user?.lastName ?? ''}`.trim(), accountType: raw.user?.accountType ?? null }
			};
		}
		const label = auditActionLabel(raw.action);
		const subject = raw.subjectUserId ? users.get(raw.subjectUserId) : null;
		const target: Target | null = raw.subjectUserId
			? { type: 'USER', typeLabel: AUDIT_ENTITY_LABELS.USER, id: raw.subjectUserId, label: subject?.name || null }
			: raw.roleId ? { type: 'ROLE', typeLabel: AUDIT_ENTITY_LABELS.ROLE, id: raw.roleId, label: roleName(raw.roleId) ?? str(obj(raw.after).name) ?? str(obj(raw.before).name) }
			: raw.inviteId ? { type: 'INVITE', typeLabel: AUDIT_ENTITY_LABELS.INVITE, id: raw.inviteId, label: null } : null;
		const sev = effectiveSeverity(raw.action, null);
		return {
			id: `ACCESS:${raw.id}`, eventId: `ACCESS:${raw.id}`, rowId: raw.id, origin: 'ACCESS' as const,
			eventType: raw.action, action: raw.action, actionLabel: label,
			category: 'SYSTEM_AUDIT', title: label, summary: null, detail: accessDetail(raw, roleName), detailDate: null,
			severity: sev.severity, severitySource: sev.source, source: 'ADMIN', status: 'COMPLETED', occurredAt: raw.at, createdAt: raw.at,
			ipAddress: null, device: null, actorLabel: null,
			actor: actorOut({ id: raw.actorId, kind: 'USER' }), target,
			account: { id: raw.actorId, name: users.get(raw.actorId)?.name ?? '', accountType: users.get(raw.actorId)?.accountType ?? null }
		};
	});

	const total = logTotal + accessTotal;
	const kinds = new Set<string>([...logKinds.map((k: any) => k.eventType), ...accessKinds.map((k: any) => k.action)].filter(Boolean));
	const eventTypes = [...kinds].sort();
	return {
		items,
		pagination: { page, limit, total, pages: Math.min(maxPage, Math.max(1, Math.ceil(total / limit))) },
		eventTypes,
		eventTypeOptions: eventTypes.map(c => ({ value: c, label: auditActionLabel(c) }))
	};
}
