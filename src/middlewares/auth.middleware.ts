import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AccountType, UserRole, UserStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { prisma } from '../config/db';
import { sessionService } from '../services/session.service';
import { getAuthCookie } from '../utils/request-cookie';

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
 * Require Active User: Block users who are PENDING_VERIFICATION or SUSPENDED
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
