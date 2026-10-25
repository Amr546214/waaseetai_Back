import { NextFunction, Request, Response } from 'express';
import { AccountType } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { AdminActor, actorHas, actorHasAny, resolveAdminActor } from '../services/admin-access.service';
import { isKnownPermission } from '../config/admin-permissions';

declare module 'express-serve-static-core' {
	interface Request { adminActor?: AdminActor }
}

export const ADMIN_PERMISSION_DENIED = 'ADMIN_PERMISSION_DENIED';
export const ADMIN_OWNER_REQUIRED = 'ADMIN_OWNER_REQUIRED';
export const ADMIN_ACCESS_UNAVAILABLE = 'ADMIN_ACCESS_UNAVAILABLE';

const deny = () => new AppError('ليست لديك صلاحية تنفيذ هذا الإجراء.', 403, undefined, ADMIN_PERMISSION_DENIED);

/** Loads the actor (once per request) from the database. Refuses when the caller is not an admin-type account, or when access cannot be established (fail closed). */
export async function loadAdminActor(req: Request): Promise<AdminActor> {
	if (req.adminActor) return req.adminActor;
	const u = req.user;
	if (!u) throw new AppError('غير مصرح لك بالوصول، يرجى تسجيل الدخول', 401);
	if (u.accountType !== AccountType.ADMIN && u.accountType !== AccountType.SUPER_ADMIN) throw new AppError('غير مصرح لك بالوصول لهذه الصلاحية', 403);
	try {
		req.adminActor = await resolveAdminActor(u.id, u.accountType);
	} catch (e) {
		logger.error(`[admin-access] could not establish access for ${u.id}: ${(e as Error).message}`);
		throw new AppError('تعذّر التحقق من صلاحياتك الآن، لم يُنفَّذ أي إجراء. حاول بعد قليل.', 503, undefined, ADMIN_ACCESS_UNAVAILABLE);
	}
	return req.adminActor;
}

/**
 * Binds a route (or a whole router) to permissions. Default mode is ALL of the ids; `anyOf` accepts one of them. An unknown id is a programming error and denies everything
 * (and is caught by the registry test) instead of silently opening the route.
 */
export const requirePermission = (...ids: string[]) => requireWith('all', ids);
export const requireAnyPermission = (...ids: string[]) => requireWith('any', ids);

function requireWith(mode: 'all' | 'any', ids: string[]) {
	const bad = ids.length === 0 || ids.some(id => !isKnownPermission(id));
	const mw = async (req: Request, _res: Response, next: NextFunction) => {
		try {
			if (bad) throw deny();
			const actor = await loadAdminActor(req);
			const ok = mode === 'all' ? actorHas(actor, ...ids) : actorHasAny(actor, ...ids);
			if (!ok) throw deny();
			next();
		} catch (e) { next(e); }
	};
	(mw as any).adminPermissions = ids; // read by the route-coverage test
	return mw;
}

/** Owner-only capabilities (staff, roles, grants). Not a permission: nobody can be given it. */
export const requireOwner = async (req: Request, _res: Response, next: NextFunction) => {
	try {
		const actor = await loadAdminActor(req);
		if (!actor.isOwner) throw new AppError('هذا الإجراء لمالك المنصة وحده.', 403, undefined, ADMIN_OWNER_REQUIRED);
		next();
	} catch (e) { next(e); }
};
(requireOwner as any).adminOwnerOnly = true;

/** Any admin-team member who currently holds at least one permission (or the owner): the minimum to enter the admin API at all (own tasks, own identity). */
export const requireAdminMember = async (req: Request, _res: Response, next: NextFunction) => {
	try {
		const actor = await loadAdminActor(req);
		if (!actor.isOwner && actor.permissions.size === 0) throw deny();
		next();
	} catch (e) { next(e); }
};
(requireAdminMember as any).adminMember = true;

/** GET / HEAD / OPTIONS need the read ids, every other method the write ids (a whole router bound with one line; a route can still add stricter ids of its own). */
export const requirePermissionByMethod = (read: string[], write: string[]) => {
	const r = requirePermission(...read), w = requirePermission(...write);
	const mw = (req: Request, res: Response, next: NextFunction) => (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? r : w)(req, res, next);
	(mw as any).adminPermissions = [...read, ...write];
	return mw;
};

/** The caller's OWN admin account only (profile, sessions, who-am-I): any admin-type account, even one that holds no permission yet. Grants no access to anything else. */
export const requireAdminAccount = async (req: Request, _res: Response, next: NextFunction) => {
	try {
		if (!req.user) throw new AppError('غير مصرح لك بالوصول، يرجى تسجيل الدخول', 401);
		if (req.user.accountType !== AccountType.ADMIN && req.user.accountType !== AccountType.SUPER_ADMIN) throw new AppError('غير مصرح لك بالوصول لهذه الصلاحية', 403);
		next();
	} catch (e) { next(e); }
};
(requireAdminAccount as any).adminSelf = true;
