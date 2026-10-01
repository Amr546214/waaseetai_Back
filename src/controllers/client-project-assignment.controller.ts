import { Request, Response, NextFunction } from 'express';
import { clientProjectAssignmentService } from '../services/client-project-assignment.service';
import { AppError } from '../utils/app-error';

// PUT /api/client/projects/:id/assigned-employee
export async function setProjectAssignedEmployee(req: Request, res: Response, next: NextFunction) {
	try {
		const companyUserId = req.user!.userId || req.user!.id;
		const projectId = String(req.params.id);
		const { employeeId } = req.body ?? {};
		if (employeeId !== null && employeeId !== undefined && typeof employeeId !== 'string') {
			throw new AppError('employeeId يجب أن يكون نصاً أو null', 400);
		}
		const result = await clientProjectAssignmentService.setAssignedEmployee(companyUserId!, projectId, employeeId ?? null);
		res.json({ success: true, data: result });
	} catch (e) { next(e); }
}
