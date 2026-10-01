import { Request, Response, NextFunction } from 'express';
import { createClientTeamMemberSchema, updateClientTeamMemberSchema } from '../dtos/client-company-team.dto';
import { companyTeamService } from '../services/company-team.service';
import { AppError } from '../utils/app-error';

// Batch 6 — reuses the exact same companyTeamService/CompanyTeamMember
// table the PROVIDER_COMPANY roster already uses (see company-team.
// controller.ts). The only difference is ownership comes from a
// CLIENT_COMPANY user (enforced by requireClientCompanyAccount in
// client-company-team.routes.ts) and memberType is always forced to
// 'EMPLOYEE' here, never accepted from the client payload.
const companyOwnerId = (req: Request) => req.user?.id || req.user?.userId;
const parse = (schema: any, body: unknown) => { const result = schema.safeParse(body); if (!result.success) throw new AppError('بيانات الموظف غير صحيحة', 400, result.error.issues); return result.data; };

export async function createClientTeamMember(req: Request, res: Response, next: NextFunction) {
	try {
		const input = { ...parse(createClientTeamMemberSchema, req.body), memberType: 'EMPLOYEE' as const };
		res.status(201).json({ success: true, data: await companyTeamService.create(companyOwnerId(req)!, input) });
	} catch (e) { next(e); }
}
export async function listClientTeamMembers(req: Request, res: Response, next: NextFunction) {
	try { res.json({ success: true, data: await companyTeamService.list(companyOwnerId(req)!) }); } catch (e) { next(e); }
}
export async function getClientTeamMember(req: Request, res: Response, next: NextFunction) {
	try { res.json({ success: true, data: await companyTeamService.get(companyOwnerId(req)!, String(req.params.id)) }); } catch (e) { next(e); }
}
export async function updateClientTeamMember(req: Request, res: Response, next: NextFunction) {
	try {
		const input = { ...parse(updateClientTeamMemberSchema, req.body), memberType: 'EMPLOYEE' as const };
		res.json({ success: true, data: await companyTeamService.update(companyOwnerId(req)!, String(req.params.id), input) });
	} catch (e) { next(e); }
}
export async function deleteClientTeamMember(req: Request, res: Response, next: NextFunction) {
	try { res.json({ success: true, data: await companyTeamService.remove(companyOwnerId(req)!, String(req.params.id)) }); } catch (e) { next(e); }
}
