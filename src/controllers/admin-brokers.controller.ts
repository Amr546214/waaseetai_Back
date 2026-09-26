import { Request, Response, NextFunction } from 'express';
import { UserStatus } from '@prisma/client';
import { adminBrokersService } from '../services/admin-brokers.service';
import { AppError } from '../utils/app-error';

export async function listBrokers(req: Request, res: Response, next: NextFunction) {
  try {
    const rawStatus = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const status = rawStatus && Object.values(UserStatus).includes(rawStatus as UserStatus) ? (rawStatus as UserStatus) : undefined;
    if (rawStatus && !status) throw new AppError('حالة غير صحيحة', 400);

    const data = await adminBrokersService.listBrokers({
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      search: req.query.search ? String(req.query.search) : undefined,
      status,
    });
    res.json({ success: true, message: 'تم جلب قائمة الوسطاء بنجاح', data });
  } catch (error) {
    next(error);
  }
}

export async function getBrokerDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminBrokersService.getBrokerDetail(String(req.params.id));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}
