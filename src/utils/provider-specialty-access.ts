import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AppError } from './app-error';

type ProviderSpecialtyOwner = {
  id: string;
  providerProfileId: string;
  providerProfile: { userId: string };
};

export async function getOwnedProviderSpecialty(providerSpecialtyId: string, userId: string): Promise<ProviderSpecialtyOwner> {
  const specialty = await prisma.providerSpecialty.findFirst({
    where: {
      id: providerSpecialtyId,
      providerProfile: { userId }
    },
    select: {
      id: true,
      providerProfileId: true,
      providerProfile: { select: { userId: true } }
    }
  });

  if (!specialty) {
    throw new AppError('التخصص غير موجود أو لا تملك صلاحية الوصول إليه', 404);
  }

  return specialty;
}

export function requireOwnedProviderSpecialtyFromParam(req: Request, _res: Response, next: NextFunction): void {
  const providerSpecialtyId = String(req.params.id || '');
  const userId = req.user?.id;

  if (!userId) {
    next(new AppError('غير مصرح لك بالوصول', 401));
    return;
  }

  getOwnedProviderSpecialty(providerSpecialtyId, userId)
    .then(specialty => {
      (req as Request & { providerSpecialty?: ProviderSpecialtyOwner }).providerSpecialty = specialty;
      next();
    })
    .catch(next);
}

export async function requireOwnedProviderSpecialtyFromBody(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const providerSpecialtyId = String(req.body?.providerSpecialtyId || '');
  const userId = req.user?.id;

  if (!userId) {
    next(new AppError('غير مصرح لك بالوصول', 401));
    return;
  }
  if (!providerSpecialtyId) {
    next(new AppError('providerSpecialtyId is required', 400));
    return;
  }

  try {
    const specialty = await getOwnedProviderSpecialty(providerSpecialtyId, userId);
    (req as Request & { providerSpecialty?: ProviderSpecialtyOwner }).providerSpecialty = specialty;
    next();
  } catch (error) {
    next(error);
  }
}
