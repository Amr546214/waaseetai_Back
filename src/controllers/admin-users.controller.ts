import { Request, Response, NextFunction } from 'express';
import { AdminUsersService } from '../services/admin-users.service';
import { adminActor } from '../utils/admin-actor';
import { accountAuditLogService } from '../services/account-logs.service';
import { z } from 'zod';
import { AppError } from '../utils/app-error';

const usersService = new AdminUsersService();

export class AdminUsersController {

	static async getStats(req: Request, res: Response, next: NextFunction) {
		try {
			const stats = await usersService.getStats();
			res.status(200).json({
				success: true,
				data: stats
			});
		} catch (error) {
			next(error);
		}
	}

	static async getUsers(req: Request, res: Response, next: NextFunction) {
		try {
			const queryParams = {
				page: req.query.page ? Number(req.query.page) : undefined,
				limit: req.query.limit ? Number(req.query.limit) : undefined,
				search: req.query.search as string,
				accountType: req.query.accountType as string,
				status: req.query.status as string,
				financialRange: req.query.financialRange as string,
				rating: req.query.rating as string,
				joinedDate: req.query.joinedDate as string,
				riskLevel: req.query.riskLevel as string,
				lastActive: req.query.lastActive as string,
				sortBy: req.query.sortBy as string,
				sortOrder: (req.query.sortOrder as 'asc' | 'desc') || 'desc'
			};

			const result = await usersService.getUsers(queryParams);
			res.status(200).json({
				success: true,
				data: result.users,
				meta: result.meta
			});
		} catch (error) {
			next(error);
		}
	}

	static async updateUserStatus(req: Request, res: Response, next: NextFunction) {
		try {
			const { status, reason } = req.body ?? {};
			if (!status) throw new AppError('الحالة مطلوبة', 400);
			const updatedUser = await usersService.updateUserStatus(adminActor(req), String(req.params.id), String(status), reason === undefined ? undefined : String(reason));
			res.status(200).json({
				success: true,
				message: 'تم تحديث حالة الحساب',
				data: updatedUser
			});
		} catch (error) {
			next(error);
		}
	}

	static async updateUserRoles(req: Request, res: Response, next: NextFunction) {
		try {
			const parsed = z.object({ roles: z.array(z.string()).min(1), activeRole: z.string().optional() }).safeParse(req.body ?? {});
			if (!parsed.success) throw new AppError('بيانات الأدوار غير صحيحة', 400);
			const data = await usersService.updateUserRoles(adminActor(req), String(req.params.id), parsed.data);
			res.status(200).json({ success: true, message: 'تم تحديث أدوار الحساب', data });
		} catch (error) {
			next(error);
		}
	}

	static async getRolesOverview(_req: Request, res: Response, next: NextFunction) {
		try {
			res.status(200).json({ success: true, data: await usersService.getRolesOverview() });
		} catch (error) {
			next(error);
		}
	}

	static async getProviderLevels(_req: Request, res: Response, next: NextFunction) {
		try {
			res.status(200).json({ success: true, data: await usersService.getProviderLevels() });
		} catch (error) {
			next(error);
		}
	}

	static async getUserDetail(req: Request, res: Response, next: NextFunction) {
		try {
			res.status(200).json({ success: true, data: await usersService.getUserDetail(String(req.params.id)) });
		} catch (error) {
			next(error);
		}
	}

	static async getUserAuditLog(req: Request, res: Response, next: NextFunction) {
		try {
			const data = await accountAuditLogService.getUserLogs(String(req.params.id), { page: Number(req.query.page) || 1, limit: Number(req.query.limit) || 20, source: typeof req.query.source === 'string' ? req.query.source : undefined });
			res.status(200).json({ success: true, data });
		} catch (error) {
			next(error);
		}
	}

	static async deleteUser(req: Request, res: Response, next: NextFunction) {
		try {
			const { id } = req.params;

			const user = (req as any).user;
			if (!user || user.accountType !== 'SUPER_ADMIN') {
				res.status(403).json({ success: false, message: 'لا يملك هذه الصلاحية سوى SUPER_ADMIN' });
				return;
			}

			await usersService.deleteUser(String(id), adminActor(req));
			res.status(200).json({
				success: true,
				message: 'تم حذف المستخدم وجميع بياناته بنجاح'
			});
		} catch (error) {
			next(error);
		}
	}

	static async exportCsv(req: Request, res: Response, next: NextFunction) {
		try {
			const queryParams = {
				search: req.query.search as string,
				accountType: req.query.accountType as string,
				status: req.query.status as string,
				financialRange: req.query.financialRange as string,
				rating: req.query.rating as string,
				joinedDate: req.query.joinedDate as string,
				riskLevel: req.query.riskLevel as string,
				lastActive: req.query.lastActive as string
			};

			const csvContent = await usersService.exportCsv(queryParams);
			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
			res.status(200).send('\uFEFF' + csvContent); // UTF-8 BOM for Excel compatibility
		} catch (error) {
			next(error);
		}
	}
}
