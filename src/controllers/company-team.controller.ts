import { Request, Response, NextFunction } from 'express';
import { createTeamMemberSchema, updateTeamMemberSchema } from '../dtos/company-team.dto';
import { companyTeamService } from '../services/company-team.service';
import { AppError } from '../utils/app-error';

const companyOwnerId = (req: Request) => req.user?.id || req.user?.userId;
const parse = (schema: any, body: unknown) => { const result = schema.safeParse(body); if (!result.success) throw new AppError('بيانات عضو الفريق غير صحيحة', 400, result.error.issues); return result.data; };

export async function createTeamMember(req: Request, res: Response, next: NextFunction) { try { res.status(201).json({ success: true, data: await companyTeamService.create(companyOwnerId(req)!, parse(createTeamMemberSchema, req.body)) }); } catch (e) { next(e); } }
export async function listTeamMembers(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await companyTeamService.list(companyOwnerId(req)!) }); } catch (e) { next(e); } }
export async function getTeamMember(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await companyTeamService.get(companyOwnerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
export async function updateTeamMember(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await companyTeamService.update(companyOwnerId(req)!, String(req.params.id), parse(updateTeamMemberSchema, req.body)) }); } catch (e) { next(e); } }
export async function deleteTeamMember(req: Request, res: Response, next: NextFunction) { try { res.json({ success: true, data: await companyTeamService.remove(companyOwnerId(req)!, String(req.params.id)) }); } catch (e) { next(e); } }
