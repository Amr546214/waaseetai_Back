import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { contentMatchesDeclaredType, looksLikeMarkup } from '../utils/file-signature';
import { uploadMulterFile, deleteCloudFile, createPrivateDownloadUrl, StoredCloudFile } from '../utils/cloudinary-storage';

export const CASE_FILE_BYTES = 10 * 1024 * 1024;
export const CASE_FILE_COUNT = 5;
export const CASE_MIMES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
export type CaseKind = 'ticket' | 'dispute';
const publicFields = { id: true, name: true, mimeType: true, bytes: true, ownerId: true, messageId: true, createdAt: true } as const;
export function validateCaseFiles(files: Express.Multer.File[]) {
  if (files.length > CASE_FILE_COUNT) throw new AppError('الحد الأقصى خمسة ملفات في الطلب', 400);
  for (const file of files) {
    if (!file.buffer?.length || file.buffer.length > CASE_FILE_BYTES) throw new AppError('حجم الملف يجب أن يكون بين بايت واحد و10 ميجابايت', 400);
    if (!CASE_MIMES.has(file.mimetype) || looksLikeMarkup(file.buffer) || !contentMatchesDeclaredType(file.buffer, file.mimetype)) throw new AppError('ارفع ملف JPG أو PNG أو PDF صالحًا', 415);
  }
}
export async function cleanupCaseFiles(files: StoredCloudFile[]) {
  const results = await Promise.allSettled(files.map(f => deleteCloudFile(f.publicId, f.resourceType, true)));
  results.forEach((r, i) => { if (r.status === 'rejected') console.error('[case-attachment] cleanup failed', files[i].publicId); });
}
// Busboy may decode a UTF-8 multipart filename as Latin-1. Preserve real Arabic names.
function displayFileName(value: string) {
  let name = value;
  if ([...value].every(c => c.charCodeAt(0) <= 255)) {
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1')); } catch { /* a real Latin-1 filename */ }
  }
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200) || 'مرفق';
}
export async function storeCaseFiles(files: Express.Multer.File[], ownerId: string) {
  validateCaseFiles(files);
  // The generic helper's local-dev mode returns placeholder URLs, not stored bytes.
  if (files.length && process.env.CLOUDINARY_CLOUD_NAME === 'local-dev') throw new AppError('تخزين المرفقات غير مهيأ في هذه البيئة', 503);
  const stored: StoredCloudFile[] = [];
  try {
    for (const file of files) stored.push(await uploadMulterFile({ ...file, originalname: `${randomUUID()}.${file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype === 'image/png' ? 'png' : 'jpg'}` }, `case-files/${ownerId}`, CASE_FILE_BYTES, true));
    if (stored.some(f => !f.privateRef)) throw new AppError('تعذر حفظ المرفق بصورة خاصة', 502);
    return { stored, rows: stored.map((f, i) => ({ ownerId, privateRef: f.privateRef!, name: displayFileName(files[i].originalname), mimeType: f.mimeType, bytes: f.bytes })) };
  } catch (e) { await cleanupCaseFiles(stored); throw e; }
}
export async function assertCaseAccess(kind: CaseKind, id: string, userId: string, admin: boolean, writable = false) {
  if (kind === 'ticket') {
    const row = await prisma.supportTicket.findUnique({ where: { id }, select: { userId: true } });
    if (!row || (!admin && row.userId !== userId)) throw new AppError('التذكرة غير موجودة', 404);
  } else {
    const row = await prisma.dispute.findUnique({ where: { id }, select: { openedById: true, againstUserId: true, status: true } });
    if (!row || (!admin && row.openedById !== userId && row.againstUserId !== userId)) throw new AppError('النزاع غير موجود', 404);
    if (writable && !['OPEN', 'UNDER_REVIEW'].includes(row.status)) throw new AppError('لا يمكن إضافة أدلة إلى نزاع مغلق', 409);
  }
}
const parent = (kind: CaseKind, id: string) => kind === 'ticket' ? { ticketId: id } : { disputeId: id };
export async function listCaseFiles(kind: CaseKind, id: string) {
  return prisma.caseAttachment.findMany({ where: parent(kind, id), select: publicFields, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}
export async function downloadCaseFile(kind: CaseKind, id: string, attachmentId: string) {
  const file = await prisma.caseAttachment.findFirst({ where: { id: attachmentId, ...parent(kind, id) } });
  if (!file) throw new AppError('المرفق غير موجود', 404);
  return createPrivateDownloadUrl(file.privateRef, 60);
}
export function caseSubmissionDigest(input: unknown, files: Express.Multer.File[]) {
  const hash = createHash('sha256').update(JSON.stringify(input));
  files.forEach(f => { hash.update(JSON.stringify([f.originalname, f.mimetype, f.buffer.length])); hash.update(f.buffer); });
  return hash.digest('hex');
}
export async function appendDisputeFiles(id: string, ownerId: string, files: Express.Multer.File[], requestKey: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey || '')) throw new AppError('معرّف إرسال الملفات غير صالح', 400);
  validateCaseFiles(files);
  const digest = caseSubmissionDigest({ ownerId, id }, files);
  if (!files.length) throw new AppError('اختر ملفًا واحدًا على الأقل', 400);
  await assertCaseAccess('dispute', id, ownerId, false, true);
  const batch = await storeCaseFiles(files, ownerId);
  let reused = false;
  try {
    const result = await prisma.$transaction(async tx => {
      // Serialises appends and closure on this row; no lost evidence or late append after resolution.
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${id} FOR UPDATE`;
      const d = await tx.dispute.findUnique({ where: { id } });
      if (!d || (d.openedById !== ownerId && d.againstUserId !== ownerId)) throw new AppError('النزاع غير موجود', 404);
      if (!['OPEN', 'UNDER_REVIEW'].includes(d.status)) throw new AppError('لا يمكن إضافة أدلة إلى نزاع مغلق', 409);
      const previous = await tx.caseAttachment.findFirst({ where: { disputeId: id, requestKey } });
      if (previous) {
        if (previous.digest !== digest) throw new AppError('معرّف الإرسال مستخدم لملفات مختلفة', 409);
        reused = true;
        return tx.caseAttachment.findMany({ where: { disputeId: id }, select: publicFields, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      }
      const count = await tx.caseAttachment.count({ where: { disputeId: id } });
      if (count + d.evidence.length + files.length > 20) throw new AppError('الحد الأقصى عشرون دليلًا للنزاع', 409);
      await tx.caseAttachment.createMany({ data: batch.rows.map(row => ({ ...row, id: randomUUID(), disputeId: id, requestKey, digest })) });
      return tx.caseAttachment.findMany({ where: { disputeId: id }, select: publicFields, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    });
    if (reused) await cleanupCaseFiles(batch.stored);
    return result;
  } catch (e) { await cleanupCaseFiles(batch.stored); throw e; }
}
