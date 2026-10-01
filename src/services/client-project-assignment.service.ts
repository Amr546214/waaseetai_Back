import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { accountAuditLogService } from './account-logs.service';

// Batch 6 — the Client Company "responsible employee" for a project
// (Project.assignedEmployeeId). The employee never executes Provider work
// and has no WaseetAI login — this purely records which of the company's
// own CompanyTeamMember rows currently follows up on/approves for this
// project. Ownership is always derived from the authenticated user
// (companyUserId), never trusted from the request body.

function formatEmployee(member: { id: string; name: string; jobTitle: string } | null | undefined) {
	if (!member) return null;
	return { id: member.id, name: member.name, jobTitle: member.jobTitle };
}

export class ClientProjectAssignmentService {
	async setAssignedEmployee(companyUserId: string, projectId: string, employeeId: string | null) {
		const project = await prisma.project.findFirst({
			where: { id: projectId, clientId: companyUserId },
			select: { id: true, assignedEmployeeId: true }
		});
		if (!project) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);

		if (employeeId) {
			// Only an ACTIVE, EMPLOYEE-typed member of the CALLER's OWN roster
			// may be assigned — never another company's member (cross-company),
			// never a PROVIDER-typed row (defense-in-depth; the client roster
			// CRUD already forces memberType EMPLOYEE, but this endpoint reads
			// from the shared company_team_members table so it checks again),
			// never PENDING/INACTIVE.
			const member = await prisma.companyTeamMember.findFirst({
				where: { id: employeeId, companyOwnerId: companyUserId, memberType: 'EMPLOYEE', status: 'ACTIVE' },
				select: { id: true }
			});
			if (!member) throw new AppError('الموظف المحدد غير متاح للتعيين — تأكد أنه موظف نشط ضمن فريق شركتك', 400);
		}

		const previousEmployeeId = project.assignedEmployeeId;
		const updated = await prisma.project.update({
			where: { id: projectId },
			data: { assignedEmployeeId: employeeId },
			include: { assignedEmployee: { select: { id: true, name: true, jobTitle: true } } }
		});

		// AccountAuditLogService.record() already redacts sensitive fields on
		// write (see its sanitize()) — only non-sensitive ids are passed here.
		// Audit logging must never block the real assignment write, so a
		// failure here is swallowed rather than surfaced as a request error.
		const eventType = !previousEmployeeId && employeeId ? 'PROJECT_EMPLOYEE_ASSIGNED'
			: previousEmployeeId && !employeeId ? 'PROJECT_EMPLOYEE_UNASSIGNED'
			: 'PROJECT_EMPLOYEE_REASSIGNED';
		accountAuditLogService.record({
			userId: companyUserId,
			eventType,
			category: 'SYSTEM_AUDIT',
			title: 'تعيين الموظف المسؤول عن المشروع',
			summary: employeeId ? 'تم تعيين موظف مسؤول عن متابعة المشروع' : 'تم إلغاء تعيين الموظف المسؤول عن المشروع',
			source: 'USER',
			status: 'COMPLETED',
			before: { employeeId: previousEmployeeId },
			after: { employeeId },
			details: { projectId }
		}).catch(() => undefined);

		return { id: updated.id, employee: formatEmployee(updated.assignedEmployee) };
	}
}

export const clientProjectAssignmentService = new ClientProjectAssignmentService();
