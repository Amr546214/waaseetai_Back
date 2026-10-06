import { z } from 'zod';
import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { LEVEL_MATRIX } from '../../utils/progression-calculators';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { llmErrorToAppError } from '../llm/llm.errors';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, NO_DATA, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';

// Feature #14 — how well an OPEN project fits the calling provider. Built in-house (LlmClient); every statement must cite fields
// that were actually sent (basedOn) and no personal data leaves the server (allowlist payload).

export const PROJECT_FIT_ALLOW: AllowRule = {
  project: { title: 'string', description: 'text', requirements: ['text'], requiredSkills: ['string'], subSpecialties: ['string'], outputs: 'text', budgetMin: 'number', budgetMax: 'number', budgetFixed: 'number', deliveryDays: 'number', category: 'string' },
  provider: { skills: ['string'], specialties: ['string'], declaredSpecialties: ['string'], yearsOfExperience: 'number', level: { index: 'number', title: 'string' } },
};

const PROJECT_FIT_PATHS = [
  'project.title', 'project.description', 'project.requirements', 'project.requiredSkills', 'project.budgetMin', 'project.budgetMax', 'project.budgetFixed',
  'project.deliveryDays', 'project.category', 'provider.skills', 'provider.specialties', 'provider.declaredSpecialties', 'provider.yearsOfExperience', 'provider.level',
];

export const ProjectFitSchema = z.object({
  overallFit: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  summary: z.string().min(1).max(700),
  matchPoints: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).max(6),
  gaps: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).max(6),
});
export type ProjectFitOutput = z.infer<typeof ProjectFitSchema>;

export const PROJECT_FIT_SYSTEM = `أنت محلل يقارن مشروعاً مفتوحاً بملف مقدّم خدمة، اعتماداً على بيانات JSON المرسلة فقط.
المطلوب: ملخص قصير (summary)، نقاط التطابق (matchPoints) والفجوات (gaps)، وتقدير عام للملاءمة overallFit (HIGH أو MEDIUM أو LOW) مبني على مقارنة project مع provider.
- قارن requiredSkills و requirements و category بمهارات المقدّم وتخصصاته وسنوات خبرته ومستواه فقط.
- لا تقيّم الميزانية أو السعر العادل ولا تقارن بالسوق.
${GROUNDING_RULES_AR}`;

export interface ProjectFitResult {
  generationSource: 'LLM' | null;
  insufficientData: boolean;
  analysis: ProjectFitOutput | null;
  inputsUsed: string[];
  unavailableFields: string[];
}

export class ProjectFitService {
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient) {}

  async analyze(userId: string, projectId: string): Promise<ProjectFitResult> {
    const raw = await this.loadProject(projectId);
    const provider = await this.loadProvider(userId);
    const payload = buildPayload({ project: raw, provider }, PROJECT_FIT_ALLOW) as any;

    const used = inputsUsed(payload, PROJECT_FIT_PATHS);
    const unavailable = PROJECT_FIT_PATHS.filter((p) => !used.includes(p));
    const projectHasContent = ['project.description', 'project.requirements', 'project.requiredSkills'].some((p) => used.includes(p));
    // nothing to compare → say so, never ask the model to fill the gap
    if (!projectHasContent || !PROJECT_FIT_PATHS.filter((p) => p.startsWith('provider.')).some((p) => used.includes(p))) {
      return { generationSource: null, insufficientData: true, analysis: null, inputsUsed: used, unavailableFields: unavailable };
    }

    try {
      const res = await this.llm.generateJson<ProjectFitOutput>({
        feature: 'project-fit', userId, schema: ProjectFitSchema, system: PROJECT_FIT_SYSTEM, input: payload,
        timeoutMs: 25_000, maxOutputTokens: 1200, cache: true,
        grounding: { basedOn: ['matchPoints[].basedOn', 'gaps[].basedOn'], freeText: ['summary', 'matchPoints[].text', 'gaps[].text'], allowedNumbers: countNumbers(payload) },
      });
      return { generationSource: res.source, insufficientData: false, analysis: res.data, inputsUsed: used, unavailableFields: unavailable };
    } catch (error) {
      throw llmErrorToAppError(error);
    }
  }

  private async loadProject(id: string) {
    const request = await prisma.clientRequest.findFirst({
      where: { id, status: 'OPEN' },
      select: { title: true, description: true, requiredSkills: true, subSpecialties: true, outputs: true, minBudget: true, maxBudget: true, expectedDurationDays: true, specialty: { select: { nameAr: true } } },
    });
    if (request) {
      return {
        title: request.title, description: request.description, requirements: [], requiredSkills: request.requiredSkills, subSpecialties: request.subSpecialties,
        outputs: request.outputs, budgetMin: request.minBudget, budgetMax: request.maxBudget, budgetFixed: null, deliveryDays: request.expectedDurationDays, category: request.specialty?.nameAr ?? null,
      };
    }
    const project = await prisma.project.findFirst({
      where: { id, status: 'OPEN' },
      select: { title: true, description: true, requirements: true, subSpecialties: true, outputs: true, budgetMin: true, budgetMax: true, budgetFixed: true, deliveryDays: true, specialty: true },
    });
    if (!project) throw new AppError('المشروع غير موجود أو غير مفتوح للعروض', 404);
    return {
      title: project.title, description: project.description, requirements: project.requirements, requiredSkills: [], subSpecialties: project.subSpecialties,
      outputs: project.outputs, budgetMin: project.budgetMin, budgetMax: project.budgetMax, budgetFixed: project.budgetFixed, deliveryDays: project.deliveryDays, category: project.specialty,
    };
  }

  private async loadProvider(userId: string) {
    const profile = await prisma.providerProfile.findUnique({
      where: { userId },
      select: {
        yearsOfExperience: true, mainSpecialty: true, subSpecialties: true, skills: { select: { name: true } },
        providerSpecialties: { where: { status: 'APPROVED' }, select: { specialty: { select: { nameAr: true } } } },
      },
    });
    if (!profile) throw new AppError('ملف مقدم الخدمة غير موجود', 404);
    const gamification = await prisma.providerGamification.findUnique({ where: { providerId: userId }, select: { currentLevelIndex: true } });
    const levelDef = gamification ? LEVEL_MATRIX.find((l) => l.index === gamification.currentLevelIndex) : undefined;
    return {
      skills: profile.skills.map((s) => s.name),
      specialties: profile.providerSpecialties.map((s) => s.specialty?.nameAr).filter((n): n is string => !!n),
      declaredSpecialties: [profile.mainSpecialty, ...(profile.subSpecialties ?? [])].filter((n): n is string => !!n),
      yearsOfExperience: profile.yearsOfExperience,
      level: levelDef ? { index: levelDef.index, title: levelDef.title } : null,
    };
  }
}

export const projectFitService = new ProjectFitService();
