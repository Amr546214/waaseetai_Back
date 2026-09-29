import { Router } from 'express';
import { notificationsController } from '../controllers/notifications.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/', notificationsController.getNotifications.bind(notificationsController));
router.get('/preferences', notificationsController.getPreferences.bind(notificationsController));
router.patch('/preferences', notificationsController.updatePreferences.bind(notificationsController));
router.patch('/read-all', notificationsController.markAllAsRead.bind(notificationsController));
router.patch('/:id/read', notificationsController.markAsRead.bind(notificationsController));

export default router;
