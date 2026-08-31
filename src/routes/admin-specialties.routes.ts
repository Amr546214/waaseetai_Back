import { Router } from 'express';
import { AdminSpecialtiesController } from '../controllers/admin-specialties.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

const router = Router();

// Apply Authentication & Admin Authorization to all admin specialties endpoints
router.use(authenticate);
router.use(authorize(AccountType.SUPER_ADMIN, AccountType.ADMIN));

// Stats and Read
router.get('/stats', AdminSpecialtiesController.getStats);
router.get('/tree', AdminSpecialtiesController.getTree);

// Categories
router.post('/categories', AdminSpecialtiesController.createCategory);
router.put('/categories/:id', AdminSpecialtiesController.updateCategory);
router.patch('/categories/:id/toggle-status', AdminSpecialtiesController.toggleCategoryStatus);
router.delete('/categories/:id', AdminSpecialtiesController.deleteCategory);

// Specialties
router.post('/', AdminSpecialtiesController.createSpecialty);
router.put('/:id', AdminSpecialtiesController.updateSpecialty);
router.patch('/:id/toggle-status', AdminSpecialtiesController.toggleStatus);
router.delete('/:id', AdminSpecialtiesController.deleteSpecialty);

export default router;
