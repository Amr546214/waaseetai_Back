import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { assertAttachmentSafe } from '../../utils/attachment-scan';
import { contentMatchesDeclaredType, looksLikeMarkup } from '../../utils/file-signature';
import { createPrivateDownloadUrl } from '../../utils/cloudinary-storage';
import { isOwnCloudinaryUrl } from '../../utils/cloudinary-url';
import { scrubFreeText } from '../llm/llm.payload';
import { redact } from '../../utils/audit-detail-sanitizer';

// Reads the files attached to a dispute so the advisory summary rests on their content, not their count. Each file is fetched server-side from our own
// storage only (private reference or our Cloudinary account), checked (type, signature, local safety scan) and read once by the AI service. Nothing is
// stored. A file that cannot be read is reported with the reason, never skipped silently.
export const DISPUTE_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DISPUTE_FILE_MAX_READ = 12;
const READABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json']);
const EXT_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json' };

export interface DisputeFileRef {
  /** who supplied it, already mapped to a label such as «العميل» */
  by: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  privateRef?: string;
  url?: string;
  origin: 'ملف نزاع' | 'دليل مرفق بالنزاع' | 'ملف تسليم المرحلة';
}
export interface DisputeFileReading { ref: DisputeFileRef; text: string; truncated: boolean; readable: boolean; reason?: string }

type Reader = { readAttachment(body: any, opts?: any): Promise<{ kind: 'TEXT' | 'IMAGE'; text: string; truncated: boolean; readable: boolean }> };
export const disputeEvidenceDeps = {
  reader: waseetAiClient as unknown as Reader,
  fetchBytes: async (url: string): Promise<Buffer> => {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

const clean = (value: string, max: number) => redact(scrubFreeText(value, max), max);
export const mimeFromName = (name: string): string | undefined => EXT_MIME[(name.split('?')[0].split('.').pop() || '').toLowerCase()];

async function readOne(ref: DisputeFileRef, actor: { userId: string; role: string }): Promise<DisputeFileReading> {
  const fail = (reason: string): DisputeFileReading => ({ ref, text: '', truncated: false, readable: false, reason });
  const mime = (ref.mimeType || mimeFromName(ref.name) || '').toLowerCase().split(';')[0].trim();
  if (!READABLE_MIME.has(mime)) return fail('نوع الملف لا تدعمه القراءة (مثل الأرشيف)');
  if (ref.bytes != null && ref.bytes > DISPUTE_FILE_MAX_BYTES) return fail('حجم الملف أكبر من 2 ميجابايت');
  try {
    let url = ref.url;
    if (ref.privateRef) url = createPrivateDownloadUrl(ref.privateRef, 60)?.url;
    else if (!url || !isOwnCloudinaryUrl(url)) return fail('الرابط خارج تخزين المنصة');
    if (!url) return fail('تعذّر تجهيز رابط القراءة');
    const bytes = await disputeEvidenceDeps.fetchBytes(url);
    if (!bytes.length || bytes.length > DISPUTE_FILE_MAX_BYTES) return fail('حجم الملف أكبر من 2 ميجابايت');
    if (!contentMatchesDeclaredType(bytes, mime)) return fail('محتوى الملف لا يطابق نوعه');
    if ((mime.startsWith('text/') || mime === 'application/json') && (bytes.includes(0) || looksLikeMarkup(bytes))) return fail('ملف نصي غير صالح');
    assertAttachmentSafe(bytes);
    const read = await disputeEvidenceDeps.reader.readAttachment({ file: bytes.toString('base64'), mimeType: mime, name: ref.name.slice(0, 120), actor }, { actor, timeoutMs: 45_000 });
    const text = clean(String(read.text || ''), 4000);
    return text ? { ref, text, truncated: !!read.truncated, readable: true } : fail('لم يُستخرج منه نص مقروء');
  } catch (error) {
    return fail(`تعذّرت القراءة (${(error as Error)?.message?.slice(0, 60) || 'خطأ'})`);
  }
}

/** Reads up to DISPUTE_FILE_MAX_READ files, four at a time. Files past the cap are reported as unread, in order. */
export async function readDisputeFiles(refs: DisputeFileRef[], actor: { userId: string; role: string }): Promise<DisputeFileReading[]> {
  const out: DisputeFileReading[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const i = next++;
      out[i] = i < DISPUTE_FILE_MAX_READ ? await readOne(refs[i], actor) : { ref: refs[i], text: '', truncated: false, readable: false, reason: `تجاوز حد القراءة (${DISPUTE_FILE_MAX_READ} ملفًا)` };
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}
