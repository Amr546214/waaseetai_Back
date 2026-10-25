import type { AdminActor } from '../services/admin-access.service';
import { actorHas } from '../services/admin-access.service';

/**
 * The dashboard is open to every admin-team member, but it only carries what that member's permissions let them see anywhere else: a block the member cannot open elsewhere is
 * REMOVED from the answer (not zeroed, not hidden by the page). Pure functions, covered by tests.
 */
const QUEUE_PERMISSION: Record<string, string> = {
	modificationRequests: 'identity.review', kyc: 'identity.review', marketerKyc: 'identity.review', affiliateRequests: 'identity.review',
	accreditation: 'specialties.approve', specialtyReview: 'specialties.approve', withdrawals: 'withdrawals.review', disputes: 'disputes.view', tickets: 'support.review',
};
const ALERT_PERMISSION: Record<string, string> = { disputesOver7Days: 'disputes.view', kycOver24h: 'identity.review', pendingWithdrawals: 'withdrawals.review' };
const ACTIVITY_PERMISSION: Record<string, string> = {
	USER_REGISTERED: 'users.view', DISPUTE_OPENED: 'disputes.view', WITHDRAWAL_REQUESTED: 'withdrawals.review', TICKET_OPENED: 'support.review', ACCREDITATION_SUBMITTED: 'specialties.approve', ADMIN_ACTION: 'audit.view',
};

export function shapeSummary(summary: any, actor: AdminActor): any {
	const k = { ...summary.kpis };
	if (!actorHas(actor, 'users.view')) delete k.users;
	if (!actorHas(actor, 'finance.read')) delete k.revenue;
	if (!actorHas(actor, 'disputes.view')) delete k.disputes;
	if (!actorHas(actor, 'support.review')) delete k.tickets;
	if (!actorHas(actor, 'withdrawals.review')) delete k.withdrawals;
	return {
		...summary, kpis: k,
		queues: (summary.queues ?? []).filter((q: any) => { const p = QUEUE_PERMISSION[q.key]; return !!p && actorHas(actor, p); }),
		alerts: (summary.alerts ?? []).filter((a: any) => { const p = ALERT_PERMISSION[a.key]; return !!p && actorHas(actor, p); }),
	};
}

export function shapeCharts(charts: any, actor: AdminActor): any {
	const out = { ...charts };
	if (!actorHas(actor, 'users.view')) { delete out.registrations; delete out.registrationsTotal; }
	if (!actorHas(actor, 'finance.read')) { delete out.commission; delete out.commissionTotal; delete out.projectsByStatus; }
	return out;
}

export function shapeActivity(activity: any, actor: AdminActor): any {
	return { ...activity, items: (activity.items ?? []).filter((i: any) => { const p = ACTIVITY_PERMISSION[i.kind]; return !!p && actorHas(actor, p); }) };
}
