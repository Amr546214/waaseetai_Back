import { prisma as defaultPrisma } from '../config/db';
import { AdminActor, actorHas } from './admin-access.service';

/**
 * Who may READ a project / contract / client request / offer through the admin API. There is no permission in the approved list that means "read all operations", so:
 *  - the LISTS (and any export) are SUPER_ADMIN-only until a dedicated read permission is approved (see OPERATIONS_MATRIX);
 *  - a DETAIL is readable by a staff member only through the case they already hold:
 *      disputes.view  -> a project / contract / request / offer that has a dispute
 *      support.review -> a project / request named by a support ticket (relatedProject / relatedOrder are matched by exact id)
 *  - everything else is refused (default deny). users.view and finance.read open NO operations data.
 * These endpoints are read-only: there is no action on them to separate.
 */
export type OperationKind = 'PROJECT' | 'CONTRACT' | 'REQUEST' | 'OFFER';

export const OPERATIONS_MATRIX: ReadonlyArray<{ surface: string; superAdmin: string; disputesView: string; supportReview: string; others: string }> = [
	{ surface: 'قائمة المشاريع / العقود / الطلبات / العروض + أي تصدير', superAdmin: 'نعم', disputesView: 'لا', supportReview: 'لا', others: 'لا (مقترح: صلاحية قراءة عمليات مستقلة، بانتظار قرار المالك)' },
	{ surface: 'تفصيل مشروع', superAdmin: 'نعم', disputesView: 'إن كان له نزاع', supportReview: 'إن ذكرته تذكرة (relatedProject = المعرّف)', others: 'لا' },
	{ surface: 'تفصيل عقد', superAdmin: 'نعم', disputesView: 'إن كان لمشروعه نزاع', supportReview: 'إن ذكرت تذكرةٌ مشروعه', others: 'لا' },
	{ surface: 'تفصيل طلب عميل', superAdmin: 'نعم', disputesView: 'إن كان له نزاع', supportReview: 'إن ذكرته تذكرة (relatedOrder = المعرّف)', others: 'لا' },
	{ surface: 'تفصيل عرض', superAdmin: 'نعم', disputesView: 'إن كان لمشروعه نزاع', supportReview: 'إن ذكرت تذكرةٌ مشروعه', others: 'لا' },
];

export async function mayReadOperation(actor: AdminActor, kind: OperationKind, id: string, db: typeof defaultPrisma = defaultPrisma): Promise<boolean> {
	if (actor.isSuperAdmin) return true;
	const viaDispute = actorHas(actor, 'disputes.view');
	const viaTicket = actorHas(actor, 'support.review');
	if (!viaDispute && !viaTicket) return false;
	if (!id || typeof id !== 'string') return false;

	let projectId: string | null = null;
	let requestId: string | null = null;
	if (kind === 'PROJECT') projectId = id;
	else if (kind === 'REQUEST') requestId = id;
	else if (kind === 'CONTRACT') projectId = (await db.contract.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
	else projectId = (await db.projectProposal.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
	if (!projectId && !requestId) return false;

	if (viaDispute) {
		const dispute = await db.dispute.findFirst({ where: projectId ? { projectId } : { requestId: requestId! }, select: { id: true } });
		if (dispute) return true;
	}
	if (viaTicket) {
		const ticket = await db.supportTicket.findFirst({ where: projectId ? { relatedProject: projectId } : { relatedOrder: requestId! }, select: { id: true } });
		if (ticket) return true;
	}
	return false;
}
