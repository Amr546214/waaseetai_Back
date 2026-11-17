import { getControlPrisma, controlTarget } from '../config/control-plane-db';
import { AppError } from '../utils/app-error';
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
