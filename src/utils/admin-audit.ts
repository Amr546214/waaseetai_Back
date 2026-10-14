import type { Request } from 'express';
import { LogCategory } from '@prisma/client';
import { accountAuditLogService } from '../services/account-logs.service';

interface AdminAuditInput {
	eventType: string;
	title: string;
	summary: string;
	before?: unknown;
	after?: unknown;
	details?: Record<string, unknown>;
	severity?: 'INFO' | 'WARNING' | 'CRITICAL';
}

/** Writes an AccountAuditLog entry for a sensitive admin action, owned by the acting admin. Throws if it cannot be written. */
export async function recordAdminAudit(req: Request, input: AdminAuditInput): Promise<void> {
	await accountAuditLogService.record({
		userId: req.user!.id,
		category: LogCategory.SYSTEM_AUDIT,
		source: 'ADMIN',
		severity: input.severity || 'INFO',
		eventType: input.eventType,
		title: input.title,
		summary: input.summary,
		before: input.before,
		after: input.after,
		details: input.details,
		context: { ipAddress: req.ip, device: String(req.headers['user-agent'] || '').slice(0, 120) || undefined, actorLabel: 'ADMIN' }
	});
}
