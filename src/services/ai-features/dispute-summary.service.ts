import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode, normalizeWaseetAiError } from '../ai/waseet-ai/waseet-ai.errors';
import type { DisputeSummaryRequest } from '../ai/waseet-ai/waseet-ai.types';
import { parseContractMilestones, readOfferTerms } from '../../utils/contract-terms';
import { scrubFreeText } from '../llm/llm.payload';
import { redact } from '../../utils/audit-detail-sanitizer';
import { currentWaseetActor } from '../ai/waseet-ai/waseet-ai.auth';
import { readDisputeFiles, mimeFromName, type DisputeFileRef } from './dispute-evidence-reader';

// Advisory-only dispute AI summary — never a verdict or financial decision.
// WaseetAI POST /v1/ai/disputes/summary generates neutral perspectives.
// Human mediators remain the sole authority on dispute outcomes.
export interface DisputeAiSummaryResult {
  summary: string;
  clientPerspective: string;
  providerPerspective: string;
}

const MAX_FIELD_LENGTH = 6000;
// Whole conversations are sent so the model sees the full record; the bounds only protect the request size. When a bound is hit the OLDEST items are
// dropped and the payload says so, so the mediator is never told the record is complete when it is not.
const MAX_DISPUTE_REPLIES = 200;
const MAX_PROJECT_MESSAGES = 600;
const CLAIM_BUDGET = 50_000;
const EVIDENCE_BUDGET = 200_000;
const FORBIDDEN_SUMMARY_KEYS = [
  'winner', 'loser', 'verdict', 'faultPercentage',
  'recommendation', 'recommendedResolution', 'releaseFunds',
  'refundAmount', 'confidence', 'confidenceOfGuilt'
];

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Source tags the payload actually carried: [R#] dispute reply, [C#] project chat, [F#] file, [S#] stage, [A#] amendment. */
const TAG = /\[([RCFSA]\d{1,4})\]/g;
export function dropUnknownCitations(text: string, known: Set<string>): string {
  return text.replace(TAG, (whole, tag) => (known.has(tag) ? whole : '')).replace(/[ \t]{2,}/g, ' ').trim();
}

function mapToDisputeSummary(value: unknown): DisputeAiSummaryResult | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isBoundedString(v.summary, MAX_FIELD_LENGTH)) return null;
  if (!isBoundedString(v.clientPerspective, MAX_FIELD_LENGTH)) return null;
  if (!isBoundedString(v.providerPerspective, MAX_FIELD_LENGTH)) return null;
  return {
    summary: v.summary,
    clientPerspective: v.clientPerspective,
    providerPerspective: v.providerPerspective,
  };
}

const cap = (text: string | null | undefined, max = 1500) => redact(scrubFreeText(text, max), max);
const timestamp = (date: Date | null | undefined) => date?.toISOString() ?? 'بلا تاريخ مسجل';
const partyLabel = { client: 'العميل', provider: 'مقدم الخدمة' };

export class DisputeSummaryService {
  constructor(
    private readonly db: Pick<typeof prisma, 'dispute'> = prisma,
    private readonly ai: Pick<typeof waseetAiClient, 'summarizeDispute'> = waseetAiClient
  ) {}

  /**
   * Summarizes a dispute for administrative review by loading dispute data from the DB,
   * minimizing claims/evidence, and calling Waseet AI's dispute summary endpoint.
   */
  async generateSummary(disputeId: string): Promise<DisputeAiSummaryResult> {
    const dispute = await this.db.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        openedById: true,
        againstUserId: true,
        stageId: true,
        reason: true,
        description: true,
        evidence: true,
        attachments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { ownerId: true, name: true, mimeType: true, bytes: true, privateRef: true } },
        messages: {
          where: { authorKind: 'PARTICIPANT', authorId: { not: null } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_DISPUTE_REPLIES,
          select: { authorId: true, authorKind: true, body: true, createdAt: true },
        },
        request: { select: { id: true, clientProfile: { select: { userId: true } } } },
        project: {
          select: {
            id: true,
            contract: {
              select: {
                clientId: true,
                providerId: true,
                terms: true,
                termsVersion: true,
                signedAt: true,
                projectConversation: {
                  select: { messages: {
                    where: { type: 'TEXT', content: { not: null } },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    take: MAX_PROJECT_MESSAGES,
                    select: { senderId: true, content: true, createdAt: true },
                  } },
                },
                amendments: {
                  where: { status: 'APPROVED', appliedAt: { not: null } },
                  orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
                  take: 50,
                  select: { title: true, description: true, type: true, appliedAt: true, durationAfter: true },
                },
                stages: {
                  orderBy: { stepOrder: 'asc' },
                  select: {
                    id: true,
                    stepOrder: true,
                    title: true,
                    status: true,
                    deliveries: {
                      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
                      take: 1,
                      select: { status: true, submittedAt: true, reviewedAt: true, note: true, files: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!dispute) throw new AppError('النزاع غير موجود', 404);

    const contract = dispute.project?.contract;
    const clientUserId = contract?.clientId ?? dispute.request?.clientProfile?.userId;
    if (!clientUserId) throw new AppError('تعذر تحديد أطراف النزاع لإنشاء الملخص', 422);

    const openerIsClient = dispute.openedById === clientUserId;
    const providerUserId = contract?.providerId ?? (openerIsClient ? dispute.againstUserId : dispute.openedById);
    const partyOf = (userId: string | null) => userId === clientUserId ? 'client' : userId && userId === providerUserId ? 'provider' : null;
    const known = new Set<string>();
    const tag = (kind: 'R' | 'C' | 'F' | 'S' | 'A', n: number) => { const t = `${kind}${n}`; known.add(t); return `[${t}]`; };
    // Keeps the NEWEST lines that fit the budget; reports how many older ones were left out.
    const fit = (lines: string[], budget: number, what: string) => {
      let used = 0, start = lines.length;
      while (start > 0 && used + lines[start - 1].length + 1 <= budget) { used += lines[start - 1].length + 1; start--; }
      return start > 0 ? [`(اختُصر السجل: حُذفت أقدم ${start} ${what} لتجاوز حد الحجم)`, ...lines.slice(start)] : lines;
    };

    // Dispute thread: every participant reply, oldest first, each with a stable source tag.
    let replyNo = 0;
    const replies = [...(dispute.messages ?? [])].reverse()
      .filter(message => message.authorKind === 'PARTICIPANT' && partyOf(message.authorId))
      .map(message => ({ party: partyOf(message.authorId)!, line: `${tag('R', ++replyNo)} رد مسجل في ${timestamp(message.createdAt)}: ${cap(message.body, 1500)}` }));
    const openerClaim = [cap(dispute.reason, 500), cap(dispute.description, 4000)].filter(Boolean).join(' — ');
    const claimFor = (party: 'client' | 'provider') => {
      const isOpener = (party === 'client') === openerIsClient;
      const lines = fit(replies.filter(r => r.party === party).map(r => r.line), CLAIM_BUDGET, 'ردود');
      return [isOpener ? `${openerClaim}` : '', ...lines].filter(Boolean).join('\n') || 'لا يوجد ادعاء مسجل من هذا الطرف ضمن الأدلة المسترجعة.';
    };

    const evidenceList: string[] = [];
    let amendmentNo = 0;
    for (const amendment of contract?.amendments ?? []) {
      if (!amendment.appliedAt) continue;
      evidenceList.push(`${tag('A', ++amendmentNo)} تعديل عقد مطبّق في ${timestamp(amendment.appliedAt)} (${amendment.type}): ${cap(amendment.title, 150)} — ${cap(amendment.description, 800)}${amendment.durationAfter != null ? ` — المدة بعد التطبيق: ${amendment.durationAfter} يومًا` : ''}`);
    }
    const stages = [...(contract?.stages ?? [])].sort((a, b) => Number(b.id === dispute.stageId) - Number(a.id === dispute.stageId));
    let stageNo = 0;
    for (const stage of stages.slice(0, 40)) {
      const delivery = stage.deliveries[0];
      evidenceList.push(`${tag('S', ++stageNo)} المرحلة ${stage.stepOrder}${stage.id && stage.id === dispute.stageId ? ' محل النزاع' : ''}: ${cap(stage.title, 150)} — الحالة: ${stage.status}${delivery ? ` — آخر تسليم: ${delivery.status} في ${timestamp(delivery.submittedAt)}${delivery.reviewedAt ? `، المراجعة: ${timestamp(delivery.reviewedAt)}` : ''}${stage.id === dispute.stageId && delivery.note ? ` — ملاحظة التسليم: ${cap(delivery.note, 1500)}` : ''}` : ' — لا تسليم'}`);
    }

    // Files: private case files, evidence links on the dispute, and the files of the disputed stage's latest delivery.
    const refs: DisputeFileRef[] = [];
    for (const file of dispute.attachments ?? []) refs.push({ by: partyLabel[partyOf(file.ownerId) ?? 'client'], name: file.name, mimeType: file.mimeType, bytes: file.bytes, privateRef: file.privateRef, origin: 'ملف نزاع' });
    const openerLabel = openerIsClient ? partyLabel.client : partyLabel.provider;
    for (const url of dispute.evidence ?? []) {
      if (typeof url !== 'string') continue;
      refs.push({ by: openerLabel, name: decodeURIComponent(url.split('?')[0].split('/').pop() || 'مرفق').slice(0, 120), mimeType: mimeFromName(url), url, origin: 'دليل مرفق بالنزاع' });
    }
    const disputedStage = contract?.stages.find(stage => stage.id === dispute.stageId);
    for (const entry of disputedStage?.deliveries[0]?.files ?? []) {
      let url = entry;
      if (entry.trim().startsWith('{')) { try { const parsed = JSON.parse(entry); url = parsed.url || parsed.fileUrl || ''; } catch { continue; } }
      if (!/^https:\/\//i.test(url)) continue;
      refs.push({ by: partyLabel.provider, name: decodeURIComponent(url.split('?')[0].split('/').pop() || 'مرفق').slice(0, 120), mimeType: mimeFromName(url), url, origin: 'ملف تسليم المرحلة' });
    }
    if (refs.length) {
      const actor = currentWaseetActor() ?? { userId: 'system', role: 'admin' };
      const readings = await readDisputeFiles(refs, { userId: actor.userId, role: actor.role });
      readings.forEach((reading, index) => {
        const head = `${tag('F', index + 1)} ${reading.ref.origin} من ${reading.ref.by}: «${cap(reading.ref.name, 80)}»`;
        evidenceList.push(reading.readable
          ? `${head} — محتوى مقروء${reading.truncated ? ' (جزء منه)' : ''}: ${reading.text}`
          : `${head} — لم يُقرأ محتواه: ${reading.reason}`);
      });
    }

    // Project chat: the whole conversation of both parties (context only, not contract text), oldest first.
    const discussion = [...(contract?.projectConversation?.messages ?? [])].reverse()
      .filter(message => partyOf(message.senderId) && message.content?.trim());
    let chatNo = 0;
    const chatLines = fit(discussion.map(message => `${tag('C', ++chatNo)} ${partyLabel[partyOf(message.senderId)!]} في ${timestamp(message.createdAt)}: ${cap(message.content, 800)}`), EVIDENCE_BUDGET, 'رسائل');
    if (chatLines.length) evidenceList.push('نقاش المشروع بين الطرفين كاملًا (سياق فقط، وليس بندًا تعاقديًا):', ...chatLines);

    const offer = readOfferTerms(contract?.terms);
    const milestones = parseContractMilestones(contract?.terms);
    const writtenTerms = typeof contract?.terms === 'string' && !milestones.length && !offer ? cap(contract.terms, 4000) : '';
    const contractTerms = contract && [
      `نسخة الشروط المحفوظة: ${contract.termsVersion} — اكتمال التوقيع: ${timestamp(contract.signedAt)}`,
      writtenTerms,
      offer?.summary && `ملخص العرض المثبت: ${cap(offer.summary, 2000)}`,
      offer?.deliverables && `التسليمات المثبتة: ${cap(offer.deliverables, 3000)}`,
      ...milestones.slice(0, 40).map(stage => `البند ${stage.order}: ${cap(stage.title, 120)} — ${cap(stage.description, 500)}`),
    ].filter(Boolean).join('\n');

    const payload: DisputeSummaryRequest = {
      disputeId: dispute.id,
      projectId: dispute.project?.id ?? dispute.request?.id ?? dispute.id,
      clientClaim: claimFor('client'),
      providerClaim: claimFor('provider'),
      ...(contractTerms ? { contractTerms } : {}),
      evidenceList,
    };

    const result = await this.generateFromPayload(payload);
    return {
      summary: dropUnknownCitations(result.summary, known),
      clientPerspective: dropUnknownCitations(result.clientPerspective, known),
      providerPerspective: dropUnknownCitations(result.providerPerspective, known),
    };
  }

  /**
   * Calls Waseet AI microservice with the prepared dispute summary payload.
   */
  async generateFromPayload(payload: DisputeSummaryRequest): Promise<DisputeAiSummaryResult> {
    try {
      const data = await this.ai.summarizeDispute(payload);
      const mapped = mapToDisputeSummary(data);

      if (!mapped || FORBIDDEN_SUMMARY_KEYS.filter((k) => k !== 'recommendation').some((k) => k in (data as object))) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI dispute summary failed validation');
      }

      return mapped;
    } catch (error: unknown) {
      const normalized = normalizeWaseetAiError(error);
      console.error('[DisputeSummaryService] AI summary generation failed:', normalized.code, normalized.status);
      throw error;
    }
  }
}

export const disputeSummaryService = new DisputeSummaryService();
