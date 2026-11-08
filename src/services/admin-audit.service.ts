import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';

/**
 * One audit trail for admin back-office actions (disputes, tickets, withdrawals, escrow views...), stored on the existing account_audit_logs table
 * so no migration is needed. The row belongs to the ADMIN (userId = admin id): it never appears in the affected user's own account log, which is
 * what keeps internal notes private. The entity it is about lives in `context` ({ entity, entityId, ... }) and is queried with a JSON path filter.
 * `summary` is a generic sentence only — a free-text body (an internal note) goes in `context.body`, never in `summary`/`title`, because the
 * security audit screen lists those two for every event.
 */
export type AdminAuditEntity = 'DISPUTE' | 'TICKET' | 'WITHDRAWAL' | 'ESCROW' | 'PROJECT' | 'CONTRACT' | 'FINANCE' | 'NOTIFICATION_TEMPLATE';

export interface AdminAuditInput {
	adminId: string;
	entity: AdminAuditEntity;
	entityId: string;
	/** Stable machine code, e.g. DISPUTE_ASSIGNED, TICKET_INTERNAL_NOTE, WITHDRAWAL_APPROVED. */
	eventType: string;
	title: string;
	summary: string;
	severity?: 'INFO' | 'WARNING' | 'CRITICAL';
	/** Extra structured details (amounts, target user, new status...). Free text such as a note body is allowed here. */
	details?: Record<string, unknown>;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
}

const asJson = (value: Record<string, unknown> | undefined) => (value ? (value as Prisma.InputJsonObject) : undefined);

const rowData = (input: AdminAuditInput): Prisma.AccountAuditLogUncheckedCreateInput => ({
	userId: input.adminId,
	category: LogCategory.SYSTEM_AUDIT,
	title: input.title,
	actionText: input.summary,
	summary: input.summary,
	status: LogStatus.COMPLETED,
	eventType: input.eventType,
	source: 'ADMIN',
	severity: input.severity ?? 'INFO',
	beforeData: asJson(input.before),
	afterData: asJson(input.after),
	context: { entity: input.entity, entityId: input.entityId, ...(input.details ?? {}) } as Prisma.InputJsonObject
});

export const adminAudit = {
	/** Writes one audit row AFTER the action, outside its transaction, and swallows a write failure (returns null). Use recordTx for a state change. */
	async record(input: AdminAuditInput) {
		try {
			return await prisma.accountAuditLog.create({ data: rowData(input) });
		} catch (error) {
			logger.error(`[admin-audit] failed to write ${input.eventType} for ${input.entityId}: ${(error as Error)?.message}`);
			return null;
		}
	},

	/**
	 * Writes the audit row INSIDE the transaction of the change: it throws on failure, so the change rolls back with it, and a rolled-back change leaves
	 * no success row. Only identifiers, statuses, counts and short codes go in `details` (never a body, an e-mail or a token).
	 */
	recordTx(tx: Prisma.TransactionClient, input: AdminAuditInput) {
		return tx.accountAuditLog.create({ data: rowData(input) });
	},

	/** Newest-first audit rows about one entity, with the acting admin. Optionally limited to some event types. */
	async listForEntity(entity: AdminAuditEntity, entityId: string, eventTypes?: string[], limit = 200, sources = ['ADMIN']) {
		const rows = await prisma.accountAuditLog.findMany({
			where: {
				source: { in: sources },
				AND: [{ context: { path: ['entity'], equals: entity } }, { context: { path: ['entityId'], equals: entityId } }],
				...(eventTypes?.length ? { eventType: { in: eventTypes } } : {})
			},
			orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
			take: limit,
			include: { user: { select: { id: true, firstName: true, lastName: true } } }
		});
		return rows.map(row => ({
			id: row.id,
			eventType: row.eventType ?? 'ADMIN_EVENT',
			title: row.title,
			summary: row.summary,
			occurredAt: row.occurredAt,
			admin: row.user ? { id: row.user.id, name: [row.user.firstName, row.user.lastName].filter(Boolean).join(' ') } : null,
			context: (row.context ?? {}) as Record<string, any>
		}));
	}
};
