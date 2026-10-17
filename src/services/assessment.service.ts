import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { waseetAiClient, type WaseetAiCallOptions } from './ai/waseet-ai/waseet-ai.client';
import type {
  CreateAssessmentRequest,
  CreateAssessmentResponse,
  SubmitAssessmentRequest,
  SubmitAssessmentResponse,
  AssessmentStatusResponse,
  AssessmentStreamRequest,
  WaseetAiStreamEvent,
} from './ai/waseet-ai/waseet-ai.types';

export interface QuizQuestionItem {
  id: string;
  subSpecialtyTag: string;
  text: string;
  options: Array<{ id: string; text: string }> | string[];
  correctOptionIndex: number;
  explanation?: string;
  /** Required for grading generated questions; there is no client-side answer key. */
  attemptId?: string;
}

export class AssessmentService {
  /**
   * Helper to randomly shuffle an array and pick a specific number of unique items
   */
  private shuffleAndPickUnique<T extends { id: any }>(array: T[], size: number): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const uniqueMap = new Map<any, T>();
    for (const item of shuffled) {
      if (!uniqueMap.has(item.id)) {
        uniqueMap.set(item.id, item);
      }
      if (uniqueMap.size === size) break;
    }

    return Array.from(uniqueMap.values());
  }

  /**
   * Generates a unique quiz for a provider based on their specialty.
   * If local questions exist in the database, uses them.
   * If the local pool is empty or AI generation is requested, delegates to Waseet AI Assessment Engine.
   */
  async generateUniqueQuiz(
    specialtyId: string,
    subSpecialties: string[] = [],
    quizSize: number = 20,
    opts?: { preferAi?: boolean; timeLimitMinutes?: number }
  ): Promise<QuizQuestionItem[]> {
    if (typeof specialtyId !== 'string' || !specialtyId.trim() || !Number.isInteger(quizSize) || quizSize < 1 || quizSize > 50 ||
      (opts?.timeLimitMinutes !== undefined && (!Number.isInteger(opts.timeLimitMinutes) || opts.timeLimitMinutes < 1 || opts.timeLimitMinutes > 180))) {
      throw new AppError('إعدادات اختبار التخصص غير صالحة', 400);
    }
    // 1. If not strictly preferring AI, check local Prisma question pool first
    if (!opts?.preferAi) {
      try {
        const availableQuestions = await prisma.question.findMany({
          where: { specialtyId, isActive: true },
        });

        if (availableQuestions.length >= quizSize) {
          const uniqueQuestions = this.shuffleAndPickUnique(availableQuestions, quizSize);
          return uniqueQuestions.map((q) => ({
            id: String(q.id),
            subSpecialtyTag: q.subSpecialtyTag || subSpecialties[0] || 'عام',
            text: q.text,
            options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
            correctOptionIndex: q.correctOptionIndex,
            explanation: q.explanation ?? undefined,
          }));
        }
      } catch (err) {
        // Fall through to Waseet AI if Prisma question query fails
      }
    }

    // 2. Connect to Waseet AI Assessment Engine (/v1/ai/assessments)
    if (waseetAiClient.isConfigured()) {
      let specialtyName = 'تخصص عام';
      try {
        const specialty = await prisma.specialty.findUnique({
          where: { id: specialtyId },
          select: { nameAr: true, name: true },
        });
        if (specialty) {
          specialtyName = specialty.nameAr || specialty.name || specialtyName;
        }
      } catch {
        // Use fallback specialty name if DB lookup is unavailable
      }

      try {
        const aiResponse = await waseetAiClient.createAssessment({
          providerSpecialtyId: specialtyId,
          specialtyName,
          questionCount: quizSize,
          timeLimitMinutes: opts?.timeLimitMinutes ?? 30,
        });

        if (aiResponse?.questions && aiResponse.questions.length > 0) {
          return aiResponse.questions.map((q) => ({
            id: String(q.id),
            subSpecialtyTag: subSpecialties[0] || 'عام',
            text: q.textAr,
            options: q.options,
            correctOptionIndex: -1, // Private answer key stays securely on Waseet AI server
            explanation: 'تم التوليد عبر محرك التقييم الذكي Waseet AI',
            attemptId: aiResponse.attemptId,
          }));
        }
      } catch {
        // Fall back to available local questions if AI generation fails
      }
    }

    // 3. Fallback: if AI failed or not configured, return any available local questions
    try {
      const fallbackQuestions = await prisma.question.findMany({
        where: { specialtyId, isActive: true },
      });
      if (fallbackQuestions.length > 0) {
        const count = Math.min(fallbackQuestions.length, quizSize);
        const picked = this.shuffleAndPickUnique(fallbackQuestions, count);
        return picked.map((q) => ({
          id: String(q.id),
          subSpecialtyTag: q.subSpecialtyTag || subSpecialties[0] || 'عام',
          text: q.text,
          options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
          correctOptionIndex: q.correctOptionIndex,
          explanation: q.explanation ?? undefined,
        }));
      }
    } catch {
      // Return empty if DB is completely unreachable
    }

    return [];
  }

  /**
   * Generates a new assessment attempt directly via Waseet AI Assessment Engine (POST /v1/ai/assessments)
   */
  async generateAssessment(
    input: CreateAssessmentRequest,
    opts?: WaseetAiCallOptions
  ): Promise<CreateAssessmentResponse> {
    return waseetAiClient.createAssessment(input, opts);
  }

  /**
   * Streams assessment questions in real-time from Waseet AI (POST /v1/ai/assessments/stream)
   */
  streamAssessmentQuestions(
    input: AssessmentStreamRequest,
    opts?: WaseetAiCallOptions
  ): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return waseetAiClient.streamAssessmentQuestions(input, opts);
  }

  /**
   * Submits candidate answers for grading to Waseet AI Assessment Engine (POST /v1/ai/assessments/:attemptId/submit)
   */
  async submitAssessment(
    attemptId: string,
    input: SubmitAssessmentRequest,
    opts?: WaseetAiCallOptions
  ): Promise<SubmitAssessmentResponse> {
    return waseetAiClient.submitAssessment(attemptId, input, opts);
  }

  /**
   * Checks the current status of an assessment attempt (GET /v1/ai/assessments/:attemptId/status)
   */
  async getAssessmentStatus(
    attemptId: string,
    opts?: WaseetAiCallOptions
  ): Promise<AssessmentStatusResponse> {
    return waseetAiClient.getAssessmentStatus(attemptId, opts);
  }
}

export const assessmentService = new AssessmentService();
