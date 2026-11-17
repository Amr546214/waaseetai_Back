import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/db';
import { getControlPrisma, controlTarget } from '../config/control-plane-db';
import { AppError } from '../utils/app-error';
import { SiteIdentityService } from './site-identity.service';
import { SystemSettingsService, systemSettingsService } from './system-settings.service';

let controlService: SystemSettingsService | null = null;

/** The settings service the admin PANEL talks to: this deployment's own, or (dev) the official site's. The runtime gates always use the local `systemSettingsService`. */
export function panelSettings(): { service: SystemSettingsService; target: 'OFFICIAL' | 'LOCAL'; db: ReturnType<typeof getControlPrisma> } {
	const db = getControlPrisma();
	if (!db) return { service: systemSettingsService, target: 'LOCAL', db: null };
	return { service: (controlService ??= new SystemSettingsService(db as never)), target: controlTarget(), db };
}

/** Saving to the other database writes an audit row that points at the acting account: it must exist there (the shared Super Admins do). */
export async function assertActorInControlPlane(actorId: string): Promise<void> {
	const db = getControlPrisma();
	if (!db) return;
	const user = await db.user.findUnique({ where: { id: actorId }, select: { accountType: true, status: true } });
	if (!user) throw new AppError('حسابك غير موجود على الموقع الرسمي، فلا يمكن تعديل إعداداته من هنا.', 409);
}

let controlIdentity: SiteIdentityService | null = null;
/** the site-identity service the admin panel talks to when it controls the official site from another deployment; undefined = this deployment's own */
export function panelSiteIdentity(): SiteIdentityService | undefined {
	const db = getControlPrisma();
	if (!db) return undefined;
	return (controlIdentity ??= new SiteIdentityService({ db: db as never }));
}

/** the database the content pages (terms, FAQ, ...) panel reads and writes: the control database when set, else this deployment's own */
export const contentDb = () => (getControlPrisma() ?? prisma);

/** router middleware: every write must come from an account that also exists in the control database */
export function requireActorInControlPlaneForWrites(req: Request, _res: Response, next: NextFunction): void {
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.user?.id || !getControlPrisma()) { next(); return; }
	assertActorInControlPlane(req.user.id).then(() => next(), next);
}
