import { AccountType, UserStatus, UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        id: string; // alias
        email: string;
        accountType: AccountType;
        status: UserStatus;
        activeRole?: UserRole;
        roles?: UserRole[];
        sessionId?: string;
      };
    }
  }
}
