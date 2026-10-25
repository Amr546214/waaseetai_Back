import { Request, Response, NextFunction } from 'express';
import { knowledgeRetrievalService } from '../services/ai-features/knowledge-retrieval.service';
import { AppError } from '../utils/app-error';
import { waseetActorRole, type WaseetActor } from '../services/ai/waseet-ai/waseet-ai.auth';
import { normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';

function verifiedActor(req: Request): WaseetActor | undefined {
  const user = req.user;
  if ((req as any).knowledgeAdminDemoted) return undefined;
  if (!user || user.status !== 'ACTIVE' || !(user.id || user.userId)) return undefined;
  return { userId: user.id || user.userId, role: waseetActorRole(user.activeRole, user.accountType) };
}

function resolveSafeAudience(req: Request): string {
  const actor = verifiedActor(req);
  const raw = typeof req.query.audience === 'string' ? req.query.audience.toLowerCase().trim() : 'all';
  if (actor?.role === 'admin' && ['all', 'client', 'provider', 'admin'].includes(raw)) return raw;
  return raw === actor?.role && (raw === 'client' || raw === 'provider') ? raw : 'all';
}

export async function searchKnowledge(req: Request, res: Response, next: NextFunction): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      throw new AppError('يرجى إدخال كلمة البحث', 400);
    }
    if (q.length > 300) {
      throw new AppError('كلمة البحث طويلة جداً (الحد الأقصى 300 حرف)', 400);
    }

    const audience = resolveSafeAudience(req);
    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new AppError('عدد نتائج البحث يجب أن يكون من 1 إلى 8', 400);
    req.once('aborted', onAbort);
    res.once('close', onClose);
    if (req.aborted) controller.abort();

    const result = await knowledgeRetrievalService.searchWithSource(q, {
      audience,
      limit,
      actor: verifiedActor(req),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;

    res.json({
      success: true,
      data: {
        query: q,
        count: result.documents.length,
        source: result.source,
        retrievalMode: result.retrievalMode,
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        documents: result.documents.map((d) => ({
          documentId: d.documentId,
          title: d.title,
          content: d.content,
          version: d.version,
          audience: d.audience,
        })),
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    const status = normalizeWaseetAiError(error).status;
    if (status === 403) return next(new AppError('البحث غير متاح لهذا الحساب', 403));
    if (status === 401) return next(new AppError('خدمة البحث غير متاحة حاليًا', 503));
    next(error);
  } finally {
    req.removeListener('aborted', onAbort);
    res.removeListener('close', onClose);
  }
}

export function listKnowledgeDocs(req: Request, res: Response): void {
  const audience = resolveSafeAudience(req);
  const docs = knowledgeRetrievalService.getAll(audience, verifiedActor(req));
  res.json({
    success: true,
    data: {
      count: docs.length,
      documents: docs.map((d) => ({
        documentId: d.documentId,
        title: d.title,
        content: d.content,
        version: d.version,
        audience: d.audience,
      })),
    },
  });
}

export function getKnowledgeDoc(req: Request, res: Response, next: NextFunction): void {
  const id = String(req.params.id);
  const doc = knowledgeRetrievalService.getById(id);
  if (!doc) {
    return next(new AppError('المستند المطلوب غير موجود', 404));
  }
  const actor = verifiedActor(req);
  if (doc.status !== 'APPROVED' || !doc.approvedBy || !doc.approvedAt ||
      (doc.audience !== 'all' && actor?.role !== 'admin' && doc.audience !== actor?.role) ||
      (doc.ownerId && actor?.role !== 'admin' && doc.ownerId !== actor?.userId)) {
    return next(new AppError('المستند المطلوب غير متاح لهذا الحساب', 403));
  }
  res.json({
    success: true,
    data: {
      documentId: doc.documentId,
      title: doc.title,
      content: doc.content,
      version: doc.version,
      audience: doc.audience,
    },
  });
}
