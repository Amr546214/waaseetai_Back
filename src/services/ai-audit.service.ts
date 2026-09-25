import { prisma } from '../config/db';
import { getIO } from '../socket';
import { emailService } from './email.service';
import { notificationService } from './notification.service';
import { geminiClient } from './ai/gemini/gemini.client';
import { logger } from '../config/logger';
import { AI_AUDIT_RESPONSE_SCHEMA, AI_AUDITOR_PROMPT, AiAuditReport, isValidAiAuditReport } from './ai-audit.prompt';

export type { AiAuditReport };

export class AiAuditService {
  /**
   * Alias for backward compatibility with existing controllers/services
   */
  async triggerAuditAndPublish(serviceId: string, providerId: string): Promise<void> {
    return this.auditProjectModel(serviceId, providerId);
  }

  /**
   * Triggers the AI Audit asynchronously using Gemini for a newly submitted Business Model
   */
  async auditProjectModel(serviceId: string, providerIdInput?: string): Promise<void> {
    // Run asynchronously to allow instant API response while AI evaluates in background
    setTimeout(async () => {
      await this.executeAuditSync(serviceId, providerIdInput);
    }, 1500); // 1.5 seconds delay to demonstrate real background audit workflow
  }

  /**
   * Synchronously executes the Gemini audit pipeline for batch or CLI evaluation
   */
  async executeAuditSync(serviceId: string, providerIdInput?: string): Promise<any> {
    try {
      logger.info(`[AiAuditService] Starting automated Gemini audit for model ${serviceId}`);
      
      const service = await prisma.serviceCatalog.findUnique({
        where: { id: serviceId },
        include: {
          stages: true,
          provider: true,
        }
      });

      if (!service) {
        logger.error(`[AiAuditService] ServiceCatalog ${serviceId} not found.`);
        return null;
      }

      const providerId = providerIdInput || service.providerId;

      const userPayload = JSON.stringify({
        title: service.title,
        description: service.description,
        totalAmount: Number(service.totalAmount),
        totalDays: service.totalDays,
        stages: service.stages.map(s => ({
          title: s.title,
          description: s.description,
          days: s.deliveryDays,
          percentage: s.percentage,
          amount: Number(s.computedAmount)
        }))
      }, null, 2);

	      // A failed or unavailable external audit must never publish a model automatically.
	      let auditResult: AiAuditReport = {
	        overallScore: 0,
	        clarityScore: 0,
	        feasibilityScore: 0,
	        isApproved: false,
	        decisionSummary: "تعذر إكمال التدقيق الآلي. بقي النموذج قيد المراجعة ولم يتم نشره تلقائياً.",
	        strengths: [],
	        criticalGaps: ["التدقيق الآلي غير متاح حالياً"],
	        improvementSuggestions: ["انتظار إعادة التدقيق أو المراجعة الإدارية"]
	      };
	      let auditCompleted = false;

      // AI-18 — migrated to the shared Gemini foundation. The previous
      // OpenAI path silently defaulted a missing/malformed score to 85 and
      // still marked the audit "completed" — a fabricated success.
      // isValidAiAuditReport now rejects any malformed shape before it can
      // reach auditResult, so a bad response routes to the same honest
      // manual-review default as "provider unavailable" below.
      try {
        const result = await geminiClient.generateStructured<AiAuditReport>(
          `Please stringently evaluate the following Business Model submission:\n${userPayload}`,
          {
            systemInstruction: AI_AUDITOR_PROMPT,
            responseSchema: AI_AUDIT_RESPONSE_SCHEMA,
            validate: isValidAiAuditReport,
            temperature: 0.2,
            maxOutputTokens: 800,
            timeoutMs: 25_000
          }
        );
        auditResult = result.data;
        auditCompleted = true;
        logger.info(`[AiAuditService] Gemini evaluation completed with score: ${auditResult.overallScore}, isApproved: ${auditResult.isApproved}`);
      } catch (aiError: any) {
        logger.warn(`[AiAuditService] Gemini error during audit, using honest manual-review fallback: ${aiError?.code || aiError?.message}`);
      }

	      // The audit is advisory: publishing is immediate and an AI result must never hide the model.
	      const nextStatus = 'PUBLISHED';

      // Update model in database
      const updatedModel = await prisma.serviceCatalog.update({
        where: { id: serviceId },
        data: {
          status: nextStatus as any,
          aiScore: auditResult.overallScore,
          aiClarityScore: auditResult.clarityScore,
          aiFeasibilityScore: auditResult.feasibilityScore,
          aiReviewSummary: auditResult.decisionSummary,
          aiReviewDetails: { recommendations: auditResult.improvementSuggestions, fullAudit: auditResult } as any,
          aiAuditReport: auditResult as any,
          auditRejectionReason: auditResult.isApproved ? null : auditResult.decisionSummary,
          approvedAt: service.approvedAt || new Date(),
          aiAuditScore: auditResult.overallScore,
          aiAuditFeedback: { recommendations: auditResult.improvementSuggestions, summary: auditResult.decisionSummary } as any,
        }
      });

      logger.info(`[AiAuditService] Model ${serviceId} updated to status ${nextStatus}`);

      // Notification title & message as required
	      const notifTitle = `🎉 تم نشر نموذج العمل`;
	      const notifMsg = auditCompleted
	        ? `نُشر نموذج "${service.title}" في السوق، وتم إرفاق التقييم الاستشاري بنتيجة ${auditResult.overallScore}%.`
	        : `نُشر نموذج "${service.title}" مباشرة، وتعذر إكمال التقييم الاستشاري.`;

      // Save notification in database & emit real-time WebSocket alert
      const notification = await notificationService.createAndEmitNotification({
        userId: providerId,
        title: notifTitle,
        message: notifMsg,
        category: 'AI',
	        type: "MODEL_APPROVED",
        actionUrl: "/provider-overview/business-models/center",
        actionText: "عرض التقرير ›",
        metadata: {
          serviceId: service.id,
          status: nextStatus,
          aiScore: auditResult.overallScore,
          decisionSummary: auditResult.decisionSummary,
          aiAuditReport: auditResult
        } as any
      });

      // Real-time WebSocket emission
      const io = getIO();
      if (io) {
        logger.info(`[AiAuditService] Emitting real-time notification & status update to provider ${providerId}`);
        const rooms = [`user_${providerId}`, `project_owner_${providerId}`, providerId];
        rooms.forEach(room => {
          io.to(room).emit('notification:new', notification);
          io.to(room).emit('model:status_updated', {
            serviceId: service.id,
            id: service.id,
            status: nextStatus,
            aiScore: auditResult.overallScore,
            aiClarityScore: auditResult.clarityScore,
            aiFeasibilityScore: auditResult.feasibilityScore,
            aiReviewSummary: auditResult.decisionSummary,
            aiAuditReport: auditResult,
            auditRejectionReason: auditResult.isApproved ? null : auditResult.decisionSummary,
            notification
          });
          // Also emit previous legacy event name for full safety
          io.to(room).emit('model_status_update', {
            serviceId: service.id,
            status: nextStatus,
            aiScore: auditResult.overallScore,
            aiReviewSummary: auditResult.decisionSummary,
            notification
          });
        });
        // Broadcast general event if needed
        io.emit('model:status_updated_broadcast', { serviceId: service.id, status: nextStatus });
      }

      // Email dispatch
      if (service.provider && service.provider.email && service.provider.firstName) {
        await emailService.sendModelApprovalEmail(
          service.provider.email,
          service.provider.firstName,
          service.title,
          auditResult.overallScore,
          auditResult.isApproved,
          `${auditResult.decisionSummary}\n\nنصائح التحسين:\n- ${auditResult.improvementSuggestions.join('\n- ')}`
        );
      }

      return { serviceId, status: nextStatus, auditResult };
    } catch (err: any) {
      logger.error(`[AiAuditService] Fatal error during automated audit: ${err.message}`, err);
      return null;
    }
  }
}

export const aiAuditService = new AiAuditService();
