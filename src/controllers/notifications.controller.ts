import { Request, Response } from 'express';
import { notificationService } from '../services/notification.service';

export class NotificationsController {
	async getNotifications(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const category = req.query.category as string | undefined;
			const notifications = await notificationService.getUserNotifications(userId, category);
			return res.status(200).json({ success: true, data: notifications }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error getting notifications:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}

	async markAsRead(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const id = String(req.params.id);
			if (!id || id === 'undefined') {
				return res.status(400).json({ success: false, error: 'Notification ID is required' }) as any;
			}
			const notification = await notificationService.markAsRead(id);
			return res.status(200).json({ success: true, data: notification }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error marking notification as read:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}

	async markAllAsRead(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			await notificationService.markAllAsRead(userId);
			return res.status(200).json({ success: true, message: 'تم تعليم كل الإشعارات كمقروءة بنجاح' }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error marking all as read:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}
}

export const notificationsController = new NotificationsController();
