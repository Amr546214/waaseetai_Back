import { Request, Response } from 'express';
import { notificationService, notificationPreferenceService } from '../services/notification.service';
import { updateNotificationPreferencesSchema } from '../dtos/notification-preferences.dto';

export class NotificationsController {
	async getNotifications(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const category = req.query.category as string | undefined;
			// `since` (ISO date): only notifications stored after it, so a reconnecting client recovers what it missed; an unreadable value is a 400, never "everything".
			const sinceRaw = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
			const since = sinceRaw ? new Date(sinceRaw) : null;
			if (since && Number.isNaN(since.getTime())) return res.status(400).json({ success: false, error: 'قيمة since غير صالحة' }) as any;
			const notifications = await notificationService.getUserNotifications(userId, category, { unreadOnly: req.query.unreadOnly === 'true', type: typeof req.query.type === 'string' && req.query.type ? req.query.type : undefined, since });
			// unreadCount = the real total for the account (not the size of the returned page), so the bell counter is exact after any recovery
			return res.status(200).json({ success: true, data: notifications, unreadCount: await notificationService.countUnread(userId) }) as any;
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
			if (!userId) {
				return res.status(401).json({ success: false, error: 'Unauthorized' }) as any;
			}
			const notification = await notificationService.markAsRead(id, userId);
			return res.status(200).json({ success: true, data: notification }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error marking notification as read:', error);
			// a notification that is not the caller's (or does not exist) is a 404, never a server error
			return res.status(typeof error?.statusCode === 'number' ? error.statusCode : 500).json({ success: false, error: error.message }) as any;
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

	async getPreferences(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const settings = await notificationPreferenceService.getPreferences(userId);
			return res.status(200).json({ success: true, data: { settings } }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error getting preferences:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}

	async updatePreferences(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const parsed = updateNotificationPreferencesSchema.safeParse(req.body);
			if (!parsed.success) {
				return res.status(400).json({ success: false, message: parsed.error.issues.map(i => i.message).join(', ') }) as any;
			}
			const settings = await notificationPreferenceService.updatePreferences(userId, parsed.data.settings);
			return res.status(200).json({ success: true, data: { settings } }) as any;
		} catch (error: any) {
			console.error('[NotificationsController] Error updating preferences:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}
}

export const notificationsController = new NotificationsController();
