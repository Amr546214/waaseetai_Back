import type { Request } from 'express';
import type { AdminActor } from '../services/admin-audit';

/** The authenticated admin behind a request, in the shape the audit helper expects. */
export const adminActor = (req: Request): AdminActor => ({ id: req.user!.id, accountType: req.user!.accountType });
