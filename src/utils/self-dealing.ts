import { AppError } from './app-error';

/**
 * Self-dealing guards. Identity is ALWAYS the real owner user id (ServiceCatalog.providerId / Contract.providerId is a User id) compared with the
 * authenticated user id — never a profile comparison and never the activeRole (a multi-role account is the same person in every role).
 * The stable `code` is forwarded by the global error handler (and also sits in errors[0].code) so the FE can branch on it, not on Arabic text.
 */
export const SELF_PURCHASE_CODE = 'SELF_PURCHASE_FORBIDDEN';
export const SELF_NEGOTIATION_CODE = 'SELF_NEGOTIATION_FORBIDDEN';
export const SELF_HIRE_CODE = 'SELF_HIRE_FORBIDDEN';
export const SERVICE_UNAVAILABLE_CODE = 'SERVICE_UNAVAILABLE_FOR_ORDER';
export const SELF_DEALING_CODES: ReadonlySet<string> = new Set([SELF_PURCHASE_CODE, SELF_NEGOTIATION_CODE, SELF_HIRE_CODE, SERVICE_UNAVAILABLE_CODE]);

export const SELF_PURCHASE_MESSAGE = 'لا يمكنك شراء خدمتك الخاصة';
export const SELF_NEGOTIATION_MESSAGE = 'لا يمكنك التفاوض على خدمتك الخاصة';
export const SELF_HIRE_MESSAGE = 'لا يمكنك التعاقد مع نفسك';
export const SERVICE_UNAVAILABLE_MESSAGE = 'إحدى خدمات الطلب لم تعد متاحة للشراء، لم يتم خصم أي مبلغ';

function coded(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
  return Object.assign(new AppError(message, status, [{ code, ...details }]), { code });
}

export const selfPurchaseError = (serviceId?: string) => coded(SELF_PURCHASE_MESSAGE, 403, SELF_PURCHASE_CODE, serviceId ? { serviceId } : {});
export const selfNegotiationError = () => coded(SELF_NEGOTIATION_MESSAGE, 403, SELF_NEGOTIATION_CODE);
export const selfHireError = () => coded(SELF_HIRE_MESSAGE, 403, SELF_HIRE_CODE);
export const serviceUnavailableError = (serviceId?: string) => coded(SERVICE_UNAVAILABLE_MESSAGE, 409, SERVICE_UNAVAILABLE_CODE, serviceId ? { serviceId } : {});

/** Throws SELF_PURCHASE_FORBIDDEN for the first service owned by `userId`. */
export function assertNoOwnService(userId: string, services: Array<{ id: string; providerId: string }>): void {
  const own = services.find(s => s.providerId === userId);
  if (own) throw selfPurchaseError(own.id);
}
