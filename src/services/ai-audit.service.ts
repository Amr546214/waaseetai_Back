import { logger } from '../config/logger';
import { aiFeatureUnavailableError } from './ai/ai-feature-unavailable';

// Automated AI audit of business models (service catalogs) is DISABLED: all AI
// must run exclusively through the WaseetAI service and no documented
// contract exists for it. This service performs NO database writes, makes NO
// AI call, never approves/rejects/publishes a model, writes no scores, sends
// no notification/e-mail and emits no socket event. Models therefore stay in
// the existing human/admin review path and model creation is never blocked.

export const AI_AUDIT_UNAVAILABLE_MESSAGE =
  'التدقيق الذكي لنماذج الأعمال متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. تبقى النماذج ضمن مسار المراجعة الإدارية المعتاد.';

export class AiAuditService {
  /** Kept for existing callers: resolves immediately, never changes the model. */
  async triggerAuditAndPublish(serviceId: string, _providerId: string): Promise<void> {
    return this.auditProjectModel(serviceId);
  }

  /** Non-blocking creation hook: logs and returns, leaving the model untouched. */
  async auditProjectModel(serviceId: string, _providerIdInput?: string): Promise<void> {
    logger.info(`[AiAuditService] AI audit is paused (no WaseetAI contract); model ${serviceId} stays in the human review path.`);
  }

  /** Explicit/admin-triggered audit: always the unavailable error, nothing is written. */
  async executeAuditSync(_serviceId: string, _providerIdInput?: string): Promise<never> {
    throw aiFeatureUnavailableError(AI_AUDIT_UNAVAILABLE_MESSAGE);
  }
}

export const aiAuditService = new AiAuditService();
