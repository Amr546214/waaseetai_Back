import { LogCategory, LogStatus, Prisma } from '@prisma/client';

/**
 * One audit row per sensitive admin action, written against the AFFECTED account (AccountAuditLog.userId) with source ADMIN. The row is built here and
 * created by the caller INSIDE the same transaction as the change (tx.accountAuditLog.create({ data })), so an action never commits without its row.
 * Only ids, statuses and short reasons go in — never emails, phones, tokens or documents.
 */
export interface AdminActor { id: string; accountType?: string }

export interface AdminAuditInput {
	actor: AdminActor;
	userId: string;
	eventType: string;
	title: string;
	summary: string;
	category?: LogCategory;
	status?: LogStatus;
	severity?: 'INFO' | 'WARNING' | 'CRITICAL';
	before?: Prisma.InputJsonValue;
	after?: Prisma.InputJsonValue;
	details?: Prisma.InputJsonObject;
}

export function adminAuditData(input: AdminAuditInput): Prisma.AccountAuditLogUncheckedCreateInput {
	return {
		userId: input.userId,
		category: input.category ?? LogCategory.SYSTEM_AUDIT,
		title: input.title.slice(0, 140),
		actionText: input.summary.slice(0, 500),
		summary: input.summary.slice(0, 500),
		eventType: input.eventType,
		source: 'ADMIN',
		severity: input.severity ?? 'INFO',
		status: input.status ?? LogStatus.COMPLETED,
		actorLabel: `${input.actor.accountType ?? 'ADMIN'}:${input.actor.id}`.slice(0, 120),
		beforeData: input.before,
		afterData: input.after,
		metaData: { adminId: input.actor.id, ...(input.details ?? {}) },
		occurredAt: new Date()
	};
}
