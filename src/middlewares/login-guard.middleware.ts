import type { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/app-error";
import { clientIpKey } from "../utils/rate-limit-identity";
import { loginGuardService } from "../services/login-guard.service";
import { recognisedOrigins, loginOriginKey } from "./rate-limit.middleware";
import { logger } from "../config/logger";
import { formatWaitArabic } from "../utils/otp-send-throttle";
export const LOGIN_BLOCKED_CODE = "LOGIN_TEMPORARILY_BLOCKED";
/** No response is released before its shared reservation has been settled. */
export const loginGuardGate =
  (identifier: (r: Request) => unknown, guard = loginGuardService) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.RATE_LIMIT_ENABLED === "false") return next();
    try {
      const raw = identifier(req),
        email =
          typeof raw === "string" && raw.trim()
            ? raw.trim().toLowerCase().slice(0, 254)
            : undefined;
      const admission = await guard.reserve({
        ip: clientIpKey(req),
        email,
        recognised:
          !!email && recognisedOrigins.has(email, loginOriginKey(req)),
      });
      if (admission.blocked) {
        res.setHeader("Retry-After", String(admission.retryAfterSeconds));
        return next(
          new AppError(
            `محاولات دخول كثيرة، حاول بعد ${formatWaitArabic(admission.retryAfterSeconds)}`,
            429,
            [
              {
                code: LOGIN_BLOCKED_CODE,
                scope: admission.scope,
                retryAfterSeconds: admission.retryAfterSeconds,
              },
            ],
          ),
        );
      }
      if (!admission.storage || !admission.lease) return next(); // The original limiters remain active if the new schema/store is unavailable.
      res.locals.sharedLoginGuard = true;
      const lease = admission.lease,
        send = res.json.bind(res);
      let settling = false,
        closed = false;
      const timer = setTimeout(() => {
        if (!res.headersSent && !closed)
          res
            .status(503)
            .json({
              success: false,
              code: "LOGIN_ATTEMPT_TIMEOUT",
              message: "انتهت مهلة الدخول؛ أعد المحاولة.",
            });
      }, 90000);
      timer.unref();
      res.once("close", () => {
        closed = true;
        clearTimeout(timer);
        if (!settling)
          void guard
            .settle(lease, 0)
            .catch((e) =>
              logger.error(
                `[LoginGuard] aborted attempt cleanup: ${(e as Error).message}`,
              ),
            );
      });
      res.json = ((body: unknown) => {
        if (settling || closed) return res;
        settling = true;
        const status = res.statusCode;
        clearTimeout(timer);
        void guard
          .settle(lease, status)
          .then(() => {
            if (!closed && !res.headersSent) send(body);
          })
          .catch((e) => {
            logger.error(
              `[LoginGuard] settlement failed: ${(e as Error).message}`,
            );
            if (!closed && !res.headersSent) {
              res.status(503);
              send({
                success: false,
                code: "LOGIN_PROTECTION_UNAVAILABLE",
                message: "تعذر إتمام الدخول بأمان؛ أعد المحاولة.",
              });
            }
          });
        return res;
      }) as typeof res.json;
      next();
    } catch (e) {
      next(e);
    }
  };
