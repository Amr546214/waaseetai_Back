import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { SETTING_BY_KEY } from '../config/system-settings.registry';
import { ACCESS_ACTION_SEVERITY, AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, accessActionSeverity, auditActionLabel } from '../utils/audit-trail-labels';

/**
 * The admin audit trail: ONE list over the two places that really record administrative events
 *  - account_audit_logs (sessions, settings, fee policy, back-office actions, KYC, finance ...), and
 *  - admin_access_audit (roles, invitations, staff access).
 * Every row carries its own identity: the event code, the Arabic name of that code (unknown codes are shown as the code), the real actor, the affected
 * target (entity + id) when the event has one, and a short factual detail built from what was stored. Nothing is invented.
 *
 * WHO is the actor: a back-office action written through adminAuditData() lives on the AFFECTED account (userId = target) and names the admin in
 * actorLabel («ADMIN:<id>» / «SUPER_ADMIN:<id>») and metaData.adminId; every other row belongs to the account that did it (userId = actor).
 *
 * SEQUENCE NUMBER (seq): neither table has a stored sequence. seq is the position of the event in the creation order (createdAt, then id) of ALL
 * administrative events (both tables together). It never changes for an existing event because new events are always created later; it would only shift if
 * old events were physically deleted (the only delete path is deleting the owning user account). A stored column (bigserial) would remove even that caveat:
 * see the NOT-EXECUTED note in the report; no migration is part of this change.
 */

const ADMIN_TYPES = ['ADMIN', 'SUPER_ADMIN'] as const;
const FETCH_CAP = 5000;
const ACTOR_LABEL = /^(?:ADMIN|SUPER_ADMIN):([0-9a-fA-F-]{36})$/;

export interface AuditTrailQuery {
	page?: unknown; limit?: unknown; q?: string; eventType?: string; severity?: string; source?: string;
	actorId?: string; from?: string; to?: string; scope?: string;
}
type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
interface Who { id: string; name: string; accountType: string | null }
interface Target { type: string; typeLabel: string; id: string | null; label: string | null }

const boundedInt = (v: unknown, fallback: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const code = (v: string) => String(v).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** the admin who did it, for an account_audit_logs row */
export function actorIdOfLog(r: { userId: string; actorLabel?: string | null; metaData?: unknown }): string {
	const m = ACTOR_LABEL.exec(r.actorLabel ?? '');
	if (m) return m[1];
	const admin = str(obj(r.metaData).adminId);
	return admin ?? r.userId;
}

/** prisma conditions for «this admin is the actor» on account_audit_logs rows (see the class comment) */
function actorWhere(id: string): Prisma.AccountAuditLogWhereInput {
	return {
		OR: [
			{ actorLabel: { endsWith: `:${id}` } },
			{ AND: [{ userId: id }, { OR: [{ actorLabel: null }, { AND: [{ NOT: { actorLabel: { startsWith: 'ADMIN:' } } }, { NOT: { actorLabel: { startsWith: 'SUPER_ADMIN:' } } }] }] }] }
		]
	};
}

const STATUS_AR: Record<string, string> = { ACTIVE: 'نشط', SUSPENDED: 'موقوف' };

/** pure: the short factual detail of an access-trail row */
export function accessDetail(a: { action: string; before?: unknown; after?: unknown }, roleName: (id: unknown) => string | null): string | null {
	const b = obj(a.before), f = obj(a.after);
	switch (a.action) {
		case 'ROLE_CREATED': return `الدور «${str(f.name) ?? '—'}» بـ ${arr(f.permissions).length} صلاحية`;
		case 'ROLE_UPDATED': {
			const parts: string[] = [];
			if (str(b.name) && str(f.name) && b.name !== f.name) parts.push(`الاسم من «${b.name}» إلى «${f.name}»`);
			else parts.push(`الدور «${str(f.name) ?? str(b.name) ?? '—'}»`);
			parts.push(`أُضيفت ${arr(f.permissionsAdded).length} وأُزيلت ${arr(f.permissionsRemoved).length} صلاحية`);
			const members = arr(f.affectedMembers).length; if (members) parts.push(`يمسّ ${members} موظفًا`);
			return parts.join(' · ');
		}
		case 'INVITE_CREATED': return `بالدور «${roleName(f.roleId) ?? '—'}»`;
		case 'INVITE_ACCEPTED': return `بالدور «${roleName(f.roleId) ?? '—'}»`;
		case 'STAFF_ATTACHED': return `بالدور «${roleName(f.roleId) ?? 'بلا دور'}»`;
		case 'STAFF_ROLE_SET': return `من «${roleName(b.roleId) ?? 'بلا دور'}» إلى «${roleName(f.roleId) ?? 'بلا دور'}»`;
		case 'STAFF_SUSPENDED': case 'STAFF_REACTIVATED': return `الحالة: ${STATUS_AR[String(b.status)] ?? str(b.status) ?? '—'} ← ${STATUS_AR[String(f.status)] ?? str(f.status) ?? '—'}`;
		case 'STAFF_ACCESS_SET': return `${arr(f.overrides).length} استثناء شخصي · النطاق ${f.scoped ? 'مقيّد بأقسام' : 'كامل'}`;
		case 'STAFF_ACCESS_RESET': return 'أُزيلت الاستثناءات الشخصية';
		default: return null;
	}
}

/** pure: the short factual detail of an account_audit_logs row; the stored summary is the fallback */
export function logDetail(r: { eventType: string; summary?: string | null; actionText?: string | null; metaData?: unknown; afterData?: unknown }): { detail: string | null; detailDate: string | null } {
	const m = obj(r.metaData);
	const fallback = str(r.summary) ?? str(r.actionText);
	switch (r.eventType) {
		case 'PLATFORM_SETTINGS_UPDATED': {
			const keys = arr(m.keys).filter((k): k is string => typeof k === 'string');
			if (keys.length) return { detail: `الإعدادات: ${keys.map(k => SETTING_BY_KEY.get(k)?.label ?? k).join('، ')}`, detailDate: null };
			return { detail: fallback, detailDate: null };
		}
		case 'FEE_POLICY_SCHEDULED': {
			const n = Object.keys(obj(r.afterData)).length;
			return { detail: `نسخة ${m.version ?? '—'}${n ? ` · ${n} تغيير` : ''} · تسري من`, detailDate: str(m.effectiveFrom) };
		}
		case 'FEE_POLICY_CANCELLED': return { detail: `النسخة المجدولة ${m.version ?? '—'}`, detailDate: null };
		default: return { detail: fallback, detailDate: null };
	}
}

/** the entity an account_audit_logs row is about, when it has one */
function logTarget(r: { eventType: string; userId: string; metaData?: unknown; context?: unknown }, actorId: string, users: Map<string, Who>): Target | null {
	const ctx = obj(r.context), m = obj(r.metaData);
	const entity = str(ctx.entity);
	if (entity) return { type: entity, typeLabel: AUDIT_ENTITY_LABELS[entity] ?? entity, id: str(ctx.entityId), label: null };
	if (r.eventType === 'PLATFORM_SETTINGS_UPDATED') return { type: 'SETTINGS', typeLabel: AUDIT_ENTITY_LABELS.SETTINGS, id: null, label: 'إعدادات المنصة' };
	if (r.eventType.startsWith('FEE_POLICY_')) return { type: 'FEE_POLICY', typeLabel: AUDIT_ENTITY_LABELS.FEE_POLICY, id: m.version != null ? String(m.version) : null, label: m.version != null ? `نسخة ${m.version}` : null };
	if (r.userId !== actorId) return { type: 'USER', typeLabel: AUDIT_ENTITY_LABELS.USER, id: r.userId, label: users.get(r.userId)?.name || null };
	return null;
}

export async function listAuditTrail(query: AuditTrailQuery, db: any = prisma) {
	const limit = boundedInt(query.limit, 20, 1, 100);
	const maxPage = Math.max(1, Math.floor(FETCH_CAP / limit));
	const page = boundedInt(query.page, 1, 1, maxPage);
	const adminScope = query.scope !== 'all';
	const sourceFilter = query.source && ['USER', 'AI', 'ADMIN', 'SYSTEM'].includes(query.source) ? query.source : null;
	const severity = query.severity && ['INFO', 'WARNING', 'CRITICAL'].includes(query.severity) ? (query.severity as Sev) : null;
	const eventType = query.eventType ? code(query.eventType) : null;
	const range: { gte?: Date; lte?: Date } = {};
	if (query.from && !Number.isNaN(Date.parse(query.from))) range.gte = new Date(query.from);
	if (query.to && !Number.isNaN(Date.parse(query.to))) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); range.lte = end; }
	const hasRange = Boolean(range.gte || range.lte);
	const text = query.q ? String(query.q).trim().slice(0, 80) : '';

	// text search also matches the Arabic action name and the name of an account involved
	let matchUserIds: string[] = [];
	let matchCodes: string[] = [];
	if (text) {
		const words = text.split(/\s+/).filter(Boolean).slice(0, 3);
		const found = await db.user.findMany({ where: { AND: words.map(w => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' } }, { lastName: { contains: w, mode: 'insensitive' } }] })) }, select: { id: true }, take: 50 });
		matchUserIds = found.map((u: any) => u.id);
		matchCodes = Object.entries(AUDIT_ACTION_LABELS).filter(([, label]) => label.includes(text)).map(([c]) => c);
	}

	// --- account_audit_logs ---
	const and: Prisma.AccountAuditLogWhereInput[] = [];
	if (adminScope) and.push({ OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] });
	if (query.actorId) and.push(actorWhere(String(query.actorId)));
	if (eventType) and.push({ eventType });
	if (severity) and.push({ severity });
	if (sourceFilter) and.push({ source: sourceFilter });
	if (text) and.push({ OR: [{ title: { contains: text, mode: 'insensitive' } }, { summary: { contains: text, mode: 'insensitive' } }, { eventType: { contains: text, mode: 'insensitive' } }, { actorLabel: { contains: text, mode: 'insensitive' } }, ...(matchCodes.length ? [{ eventType: { in: matchCodes } }] : []), ...(matchUserIds.length ? [{ userId: { in: matchUserIds } }] : [])] });
	if (hasRange) and.push({ occurredAt: range });
	const logWhere: Prisma.AccountAuditLogWhereInput = and.length ? { AND: and } : {};

	// --- admin_access_audit (administrative scope only; its events are always source ADMIN) ---
	const withAccess = adminScope && (!sourceFilter || sourceFilter === 'ADMIN');
	const aand: Prisma.AdminAccessAuditWhereInput[] = [];
	if (query.actorId) aand.push({ actorId: String(query.actorId) });
	if (eventType) aand.push({ action: eventType });
	const sevCodes = Object.keys(ACCESS_ACTION_SEVERITY).filter(c => ACCESS_ACTION_SEVERITY[c] === 'WARNING');
	if (severity === 'WARNING') aand.push({ action: { in: sevCodes } });
	else if (severity === 'INFO') aand.push({ action: { notIn: sevCodes } });
	else if (severity === 'CRITICAL') aand.push({ action: { in: [] } });
	if (text) aand.push({ OR: [{ action: { contains: text.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || '__none__' } }, ...(matchCodes.length ? [{ action: { in: matchCodes } }] : []), ...(matchUserIds.length ? [{ actorId: { in: matchUserIds } }, { subjectUserId: { in: matchUserIds } }] : [])] });
	if (hasRange) aand.push({ at: range });
	const accessWhere: Prisma.AdminAccessAuditWhereInput = aand.length ? { AND: aand } : {};

	const need = Math.min(page * limit, FETCH_CAP);
	const [logRows, logTotal, accessRows, accessTotal, logKinds, accessKinds] = await Promise.all([
		db.accountAuditLog.findMany({
			where: logWhere, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: need,
			select: { id: true, eventType: true, category: true, title: true, summary: true, actionText: true, severity: true, source: true, status: true, occurredAt: true, ipAddress: true, device: true, actorLabel: true, userId: true, metaData: true, afterData: true, context: true, user: { select: { firstName: true, lastName: true, accountType: true } } }
		}),
		db.accountAuditLog.count({ where: logWhere }),
		withAccess ? db.adminAccessAudit.findMany({ where: accessWhere, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: need }) : Promise.resolve([]),
		withAccess ? db.adminAccessAudit.count({ where: accessWhere }) : Promise.resolve(0),
		db.accountAuditLog.groupBy({ by: ['eventType'], where: adminScope ? { OR: [{ user: { accountType: { in: [...ADMIN_TYPES] } } }, { source: 'ADMIN' }] } : {}, _count: { _all: true } }),
		adminScope ? db.adminAccessAudit.groupBy({ by: ['action'], _count: { _all: true } }) : Promise.resolve([])
	]);

	type Row = { at: Date; id: string; kind: 'LOG' | 'ACCESS'; raw: any };
	const merged: Row[] = [
		...logRows.map((raw: any) => ({ at: raw.occurredAt as Date, id: raw.id as string, kind: 'LOG' as const, raw })),
		...accessRows.map((raw: any) => ({ at: raw.at as Date, id: raw.id as string, kind: 'ACCESS' as const, raw }))
	].sort((x, y) => (y.at.getTime() - x.at.getTime()) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
	const pageRows = merged.slice((page - 1) * limit, page * limit);

	// names / roles for everything the visible rows mention
	const userIds = new Set<string>(); const roleIds = new Set<string>();
	for (const r of pageRows) {
		if (r.kind === 'LOG') { userIds.add(r.raw.userId); userIds.add(actorIdOfLog(r.raw)); }
		else {
			userIds.add(r.raw.actorId); if (r.raw.subjectUserId) userIds.add(r.raw.subjectUserId);
			for (const v of [r.raw.roleId, obj(r.raw.before).roleId, obj(r.raw.after).roleId]) if (typeof v === 'string') roleIds.add(v);
		}
	}
	const [userRows, roleRows, seqRows] = await Promise.all([
		userIds.size ? db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, firstName: true, lastName: true, accountType: true } }) : [],
		roleIds.size ? db.adminRole.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, name: true } }) : [],
		pageRows.length && adminScope ? db.$queryRaw(Prisma.sql`
			SELECT id, rn::int AS seq FROM (
				SELECT id, row_number() OVER (ORDER BY ts, id) AS rn FROM (
					SELECT l.id, l."createdAt" AS ts FROM account_audit_logs l JOIN users u ON u.id = l."userId" WHERE l.source = 'ADMIN' OR u."accountType" IN ('ADMIN', 'SUPER_ADMIN')
					UNION ALL SELECT a.id, a.at AS ts FROM admin_access_audit a
				) x
			) y WHERE id IN (${Prisma.join(pageRows.map(r => r.id))})`) : []
	]);
	const users = new Map<string, Who>(userRows.map((u: any) => [u.id, { id: u.id, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), accountType: u.accountType ?? null }]));
	const roles = new Map<string, string>(roleRows.map((r: any) => [r.id, r.name]));
	const seq = new Map<string, number>((seqRows as any[]).map(s => [s.id, Number(s.seq)]));
	const who = (id: string): Who => users.get(id) ?? { id, name: '', accountType: null };
	const roleName = (id: unknown) => (typeof id === 'string' ? roles.get(id) ?? null : null);

	const items = pageRows.map(({ kind, raw }) => {
		if (kind === 'LOG') {
			const eventTypeCode = raw.eventType || 'SYSTEM_EVENT';
			const actorId = actorIdOfLog(raw);
			const { detail, detailDate } = logDetail({ eventType: eventTypeCode, summary: raw.summary, actionText: raw.actionText, metaData: raw.metaData, afterData: raw.afterData });
			const target = logTarget({ eventType: eventTypeCode, userId: raw.userId, metaData: raw.metaData, context: raw.context }, actorId, users);
			return {
				id: raw.id, seq: seq.get(raw.id) ?? null, origin: 'LOG' as const,
				eventType: eventTypeCode, action: eventTypeCode, actionLabel: auditActionLabel(eventTypeCode),
				category: raw.category, title: raw.title, summary: raw.summary || raw.actionText, detail, detailDate,
				severity: raw.severity || 'INFO', source: raw.source || 'SYSTEM', status: raw.status, occurredAt: raw.occurredAt,
				ipAddress: raw.ipAddress, device: raw.device, actorLabel: raw.actorLabel,
				actor: who(actorId), target,
				account: { id: raw.userId, name: `${raw.user?.firstName ?? ''} ${raw.user?.lastName ?? ''}`.trim(), accountType: raw.user?.accountType ?? null }
			};
		}
		const label = auditActionLabel(raw.action);
		const subject = raw.subjectUserId ? who(raw.subjectUserId) : null;
		const target: Target | null = raw.subjectUserId
			? { type: 'USER', typeLabel: AUDIT_ENTITY_LABELS.USER, id: raw.subjectUserId, label: subject?.name || null }
			: raw.roleId ? { type: 'ROLE', typeLabel: AUDIT_ENTITY_LABELS.ROLE, id: raw.roleId, label: roleName(raw.roleId) ?? str(obj(raw.after).name) ?? str(obj(raw.before).name) }
			: raw.inviteId ? { type: 'INVITE', typeLabel: AUDIT_ENTITY_LABELS.INVITE, id: raw.inviteId, label: null } : null;
		return {
			id: raw.id, seq: seq.get(raw.id) ?? null, origin: 'ACCESS' as const,
			eventType: raw.action, action: raw.action, actionLabel: label,
			category: 'SYSTEM_AUDIT', title: label, summary: null, detail: accessDetail(raw, roleName), detailDate: null,
			severity: accessActionSeverity(raw.action), source: 'ADMIN', status: 'COMPLETED', occurredAt: raw.at,
			ipAddress: null, device: null, actorLabel: null,
			actor: who(raw.actorId), target,
			account: { id: raw.actorId, name: who(raw.actorId).name, accountType: who(raw.actorId).accountType }
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
