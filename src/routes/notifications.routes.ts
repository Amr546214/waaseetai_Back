import { Router } from 'express';
import { notificationsController } from '../controllers/notifications.controller';

const router = Router();

router.get('/', notificationsController.getNotifications.bind(notificationsController));
router.patch('/read-all', notificationsController.markAllAsRead.bind(notificationsController));
router.patch('/:id/read', notificationsController.markAsRead.bind(notificationsController));

export default router;
