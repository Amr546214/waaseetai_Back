import { Router, Request, RequestHandler } from 'express';
import { assertCaseAccess, listCaseFiles, downloadCaseFile, appendDisputeFiles, CASE_FILE_BYTES, CASE_FILE_COUNT, CASE_MIMES, CaseKind } from '../services/case-attachments.service';
import { memoryUpload } from '../utils/cloudinary-storage';

const caseId = (req: Request) => String(req.params.id);

export const caseFilesUpload = memoryUpload({ fileSize: CASE_FILE_BYTES, files: CASE_FILE_COUNT, allowedMimeTypes: CASE_MIMES }).array('attachments', CASE_FILE_COUNT);
/** Mount after the parent router's authentication, active-account and (for staff) permission guards. */
export function caseAttachmentsRouter(kind: CaseKind, admin = false) {
  const router = Router({ mergeParams: true });
  const access: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await assertCaseAccess(kind, caseId(req), req.user!.userId || req.user!.id, admin, req.method === 'POST'); next(); } catch (e) { next(e); }
  };
  router.use(access);
  router.get('/', async (req, res, next) => { try { res.json({ success: true, data: await listCaseFiles(kind, caseId(req)) }); } catch (e) { next(e); } });
  router.get('/:attachmentId/download', async (req, res, next) => { try { res.json({ success: true, data: await downloadCaseFile(kind, caseId(req), String(req.params.attachmentId)) }); } catch (e) { next(e); } });
  if (kind === 'dispute' && !admin) router.post('/', caseFilesUpload, async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await appendDisputeFiles(caseId(req), req.user!.userId || req.user!.id, (req.files || []) as Express.Multer.File[], req.body.requestKey) }); } catch (e) { next(e); }
  });
  return router;
}

/** Express 5 hides mounted paths; preserve the same metadata app.ts uses for OpenAPI. */
export function mountCaseAttachments(parent: Router, path: string, kind: CaseKind, admin = false, ...guards: RequestHandler[]) {
  parent.use(path, ...guards, caseAttachmentsRouter(kind, admin));
  const layer = parent.stack.at(-1) as unknown as { __swaggerPath?: string } | undefined;
  if (layer) layer.__swaggerPath = path;
}
