import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AccountType, UserRole, UserStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { prisma } from '../config/db';
import { sessionService } from '../services/session.service';
import { getAuthCookie } from '../utils/request-cookie';
import { logger } from '../config/logger';

// Express Request interface is extended via src/types/express.d.ts

/**
 * Authenticate incoming requests via JWT (Bearer header or Cookie fallback) and validate against Database
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      token = getAuthCookie(req) || null;
    }

    if (!token) {
      throw new AppError('غير مصرح لك بالوصول، يرجى تسجيل الدخول', 401);
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new AppError('خطأ في إعدادات الخادم: مفتاح التشفير JWT_SECRET غير معرّف', 500);
    }
    
    // Decode and verify the token
    const decoded = jwt.verify(token, jwtSecret) as { userId: string; accountType: AccountType; activeRole?: UserRole; roles?: UserRole[]; exp?: number };

    // Database Check: Ensure the user still exists in the DB
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, accountType: true, status: true, activeRole: true, roles: true }
    });

    if (!user) {
      throw new AppError('حساب المستخدم لم يعد موجوداً', 401);
    }

    const session = await sessionService.validateOrRegister(user.id, token, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    }, decoded.exp ? new Date(decoded.exp * 1000) : undefined);
    if (!session) throw new AppError('تم إنهاء جلسة العمل هذه، يرجى تسجيل الدخول مجددًا', 401);

    // Attach user payload safely to the request object
    req.user = {
      userId: user.id,
      id: user.id,
      email: user.email,
      accountType: user.accountType,
      status: user.status,
      activeRole: user.activeRole || decoded.activeRole,
      roles: user.roles && user.roles.length > 0 ? user.roles : (decoded.roles || []),
      sessionId: session.id
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      next(new AppError('جلسة العمل انتهت، يرجى إعادة تسجيل الدخول', 401));
    } else {
      next(error);
    }
  }
};

/**
 * Batch 4 — optional identification for PUBLIC marketplace read routes
 * (listing/detail) that must stay fully accessible to guests, but also need
 * to know WHICH client is asking so they can read back that client's own
 * active-purchase eligibility (see findActiveServicePurchases). Mirrors
 * `authenticate`'s exact token-verification logic, but NEVER rejects the
 * request: these routes never carried `authenticate`/`requireActiveUser` at
 * all, so EVERY credential state below — absent, malformed, invalid,
 * expired, or a revoked/expired session — already resulted in an identical
 * public response before this middleware existed (no req.user, in every
 * case). This middleware only ever ADDS a positive case (a genuinely valid,
 * active session) on top of that; it changes nothing about how any invalid
 * case is handled, so it cannot "downgrade" security that was never present
 * on these routes. It is never a substitute for `authenticate` on a route
 * that actually requires a logged-in user.
 *
 * Batch 4 security review: explicitly distinguishes the two families of
 * failure. A credential that is verifiably invalid on its own terms (no
 * token, bad signature, expired JWT, or `requireActiveUser`-equivalent
 * status/session rejection) is expected, routine, and silently treated as
 * "no identity" — exactly this route's pre-existing behavior. An
 * UNEXPECTED failure (e.g. the database being unreachable) is NOT silently
 * swallowed: it is logged as a real operational problem, even though the
 * request still proceeds as a guest either way (these routes must never be
 * blocked by an infra hiccup) — so a systemic issue can never masquerade as
 * routine, invisible guest traffic.
 */
export const optionalAuthenticate = async (req: Request, res: Response, next: NextFunction) => {
  let token: string | null = null;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      token = getAuthCookie(req) || null;
    }

    // Case A — no credential supplied at all: the cheap, common path, no
    // DB/JWT work attempted.
    if (!token) return next();

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('[optionalAuthenticate] JWT_SECRET is not configured — treating request as guest');
      return next();
    }

    // Cases D/E/F — malformed/invalid/expired credential: jwt.verify throws
    // TokenExpiredError/JsonWebTokenError, caught below and treated as "no
    // identity" — the same outcome this route always had for such a token.
    const decoded = jwt.verify(token, jwtSecret) as { userId: string; accountType: AccountType; activeRole?: UserRole; roles?: UserRole[]; exp?: number };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, accountType: true, status: true, activeRole: true, roles: true }
    });
    // Deleted account, or (mirroring requireActiveUser's own rule) an
    // account that is not currently active — never attach identity for it.
    if (!user || user.status === UserStatus.SUSPENDED || user.status === UserStatus.SUSPENDED_REVIEW || user.status === UserStatus.PENDING_VERIFICATION) {
      return next();
    }

    // Case G — revoked/expired session: validateOrRegister returns null
    // exactly as it does for `authenticate`, treated the same way here.
    const session = await sessionService.validateOrRegister(user.id, token, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    }, decoded.exp ? new Date(decoded.exp * 1000) : undefined);
    if (!session) return next();

    // Case B/C — a genuinely valid, active session: identity is attached
    // for ANY authenticated role (not just Client) — it is the SERVICE
    // layer (marketplace-service.service.ts, gated on accountType) that
    // decides whether to compute/return eligibility, so a non-Client's
    // request remains valid but never receives Client eligibility metadata.
    req.user = {
      userId: user.id,
      id: user.id,
      email: user.email,
      accountType: user.accountType,
      status: user.status,
      activeRole: user.activeRole || decoded.activeRole,
      roles: user.roles && user.roles.length > 0 ? user.roles : (decoded.roles || []),
      sessionId: session.id
    };
    next();
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError)) {
      // Anything other than an expected "this credential is invalid" error
      // (a DB error, an unexpected exception, etc.) must stay visible.
      logger.error('[optionalAuthenticate] unexpected failure while attempting optional identification — continuing as guest', error);
    }
    next();
  }
};

/**
 * Require Active User: Block users who are PENDING_VERIFICATION, SUSPENDED or SUSPENDED_REVIEW
 */
export const requireActiveUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return next(new AppError('غير مصرح لك بالوصول', 401));
  }

  if (req.user.status === UserStatus.PENDING_VERIFICATION) {
    return next(new AppError('يرجى تفعيل حسابك أولاً باستخدام رمز التحقق (OTP) للوصول إلى هذه الصفحة', 403));
  }

  if (req.user.status === UserStatus.SUSPENDED) {
    return next(new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403));
  }

  // An account under suspension review is blocked exactly like a suspended one.
  if (req.user.status === UserStatus.SUSPENDED_REVIEW) {
    return next(new AppError('هذا الحساب قيد مراجعة الإيقاف حالياً، يرجى التواصل مع الدعم', 403));
  }

  next();
};

/**
 * Authorize specific Account Types & Multi-Role User Roles
 */
export const authorize = (...allowedAccountTypes: AccountType[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('غير مصرح لك بالوصول، يرجى تسجيل الدخول', 401));
    }

    const { accountType, activeRole, roles } = req.user;

    // Direct account type match
    if (allowedAccountTypes.includes(accountType)) {
      return next();
    }

    // Role-based equivalence check for Multi-Role User Architecture
    const userRoles = new Set<UserRole>(roles || []);
    if (activeRole) userRoles.add(activeRole);

    const isAuthorized = allowedAccountTypes.some(type => {
      if (type === AccountType.MARKETING_BROKER && userRoles.has(UserRole.AFFILIATE)) return true;
      if ((type === AccountType.PROVIDER_INDIVIDUAL || type === AccountType.PROVIDER_COMPANY) && userRoles.has(UserRole.PROVIDER)) return true;
      if ((type === AccountType.CLIENT_INDIVIDUAL || type === AccountType.CLIENT_COMPANY) && userRoles.has(UserRole.CLIENT)) return true;
      if (type === AccountType.SUPER_ADMIN && userRoles.has(UserRole.SUPER_ADMIN)) return true;
      if (type === AccountType.ADMIN && (userRoles.has(UserRole.ADMIN) || userRoles.has(UserRole.SUPER_ADMIN))) return true;
      return false;
    });

    if (isAuthorized) {
      return next();
    }

    return next(new AppError('غير مصرح لك بالوصول لهذه الصلاحية', 403));
  };
};
