import { Router } from 'express';
import { notificationsController } from '../controllers/notifications.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);

// Reading notifications stays open for every authenticated account (a suspended / pending user must be able to read WHY); anything that
// changes state requires an active account.
router.get('/', notificationsController.getNotifications.bind(notificationsController));
router.get('/preferences', notificationsController.getPreferences.bind(notificationsController));
router.patch('/preferences', requireActiveUser, notificationsController.updatePreferences.bind(notificationsController));
router.patch('/read-all', requireActiveUser, notificationsController.markAllAsRead.bind(notificationsController));
router.patch('/:id/read', requireActiveUser, notificationsController.markAsRead.bind(notificationsController));

export default router;
