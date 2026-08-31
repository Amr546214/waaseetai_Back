import { Request, Response, NextFunction } from 'express';
import { AdminUsersService } from '../services/admin-users.service';

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
			const { id } = req.params;
			const { status } = req.body;
			if (!status) {
				res.status(400).json({ success: false, message: 'Status is required' });
				return;
			}

			const updatedUser = await usersService.updateUserStatus(String(id), String(status));
			res.status(200).json({
				success: true,
				message: 'User status updated successfully',
				data: updatedUser
			});
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

			await usersService.deleteUser(String(id));
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
