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
      // Raw request body bytes, captured by express.json()'s `verify` hook in
      // app.ts alongside the normal parsed req.body. Needed by webhook
      // signature verification (e.g. PayPal), which must check the exact
      // bytes as sent — never the re-serialized parsed object.
      rawBody?: Buffer;
    }
  }
}
