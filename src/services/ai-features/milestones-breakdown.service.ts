import { AppError } from '../../utils/app-error';
import { waseetAiClient, type WaseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from '../ai/waseet-ai/waseet-ai.errors';
import { buildMilestonesRequest, mapMilestonesResponse } from '../ai/waseet-ai/waseet-ai.adapters';

export interface MilestoneBreakdownItem {
  title: string;
  description: string;
  days: number;
  percentage: number;
  amount: number;
}

export interface MilestoneBreakdownInput {
  title: string;
  description: string;
  totalAmount: number;
  currency?: string;
  deliveryDays?: number;
}

export interface MilestoneBreakdownResult {
  milestones: MilestoneBreakdownItem[];
  totalAmount: number;
  totalDays: number;
}

const MILESTONES_FAILED_MESSAGE = 'تعذر اقتراح تفصيل مراحل المشروع عبر الذكاء الاصطناعي حالياً. يرجى المحاولة لاحقاً.';

export class MilestonesBreakdownService {
  constructor(private readonly client: WaseetAiClient = waseetAiClient) {}

  /**
   * Generates a concrete breakdown of project milestones using Waseet AI microservice (POST /v1/ai/milestones).
   * Enforces 100% total percentage, accurate currency splits, and delivery timeline bounds.
   */
  async generateBreakdown(input: MilestoneBreakdownInput): Promise<MilestoneBreakdownResult> {
    const request = buildMilestonesRequest(input || {});
    const currency = input?.currency ?? 'USD';
    if (!request || !/^[A-Z]{3}$/.test(currency)) {
      throw new AppError('عنوان المشروع ووصفه ومبلغ صالح بالسنتات ومدة صحيحة مطلوبة لاقتراح المراحل', 400);
    }
    request.currency = currency;
    const totalAmount = request.totalAmount;
    try {
      const response = await this.client.suggestMilestones(request);
      const milestones = mapMilestonesResponse(response);
      const totalDays = milestones.reduce((sum, item) => sum + item.estimatedDays, 0);
      if (input.deliveryDays !== undefined && totalDays > input.deliveryDays) {
        throw new Error('MILESTONE_TIMELINE_EXCEEDED');
      }
      // Largest remainder allocation conserves cents without a negative last stage.
      const cents = Math.round(totalAmount * 100);
      const shares = milestones.map(item => cents * item.percentage! / 100);
      const amounts = shares.map(Math.floor);
      const remainder = cents - amounts.reduce((sum, amount) => sum + amount, 0);
      const order = shares.map((share, index) => ({ index, fraction: share - amounts[index] }))
        .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
      for (let index = 0; index < remainder; index++) amounts[order[index % order.length].index]++;
      return {
        milestones: milestones.map((item, index) => ({ title: item.title, description: item.description,
          days: item.estimatedDays, percentage: item.percentage!, amount: amounts[index] / 100 })),
        totalAmount, totalDays,
      };
    } catch (error) {
      const e = normalizeWaseetAiError(error);
      console.error(`[MilestonesBreakdownService] Waseet AI milestones failed: code=${e.code} status=${e.status ?? '-'}`);
      throw new AppError(MILESTONES_FAILED_MESSAGE, 503);
    }

  }
}

export const milestonesBreakdownService = new MilestonesBreakdownService();
