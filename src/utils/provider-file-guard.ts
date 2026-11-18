import { AppError } from './app-error';
import type { WaseetActor } from '../services/ai/waseet-ai/waseet-ai.auth';
import { inspectIdentityFile, IDENTITY_FILE_AI_MAX_BYTES } from './identity-file-verdict';

// Server-side enforcement of the AI file check at upload time. The browser also checks (to answer fast), but a request that skips the browser
// reaches this guard: a file that is clearly not what the slot asks for (no identity document / no person with a document / no certificate,
// or unreadable) is refused with 422 and NOTHING is stored. Anything the AI cannot judge (AI down, > 7.5MB, unsupported type) is accepted
// and left to the human review. Work samples (MODEL/PROOF) are scored by the browser flow and are not refused here.
export type ProviderFileKind = 'ID_DOCUMENT' | 'SELFIE' | 'CERTIFICATE';
export const PROVIDER_FILE_KINDS: readonly ProviderFileKind[] = ['ID_DOCUMENT', 'SELFIE', 'CERTIFICATE'];
/** Every upload must name what it is for. Only the first three are AI-checked here; the others are labels (stored under their own folder so a file cannot be re-used as an identity document / selfie / certificate). */
export const UPLOAD_KINDS = ['ID_DOCUMENT', 'SELFIE', 'CERTIFICATE', 'AVATAR', 'PORTFOLIO_MODEL', 'PORTFOLIO_PROOF', 'BUSINESS_DOCUMENT'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const isUploadKind = (v: unknown): v is UploadKind => typeof v === 'string' && (UPLOAD_KINDS as readonly string[]).includes(v);
/** the sub-folder of `…/documents/` the file is stored in */
export const uploadKindFolder = (kind: UploadKind) => kind.toLowerCase();
export const PROVIDER_FILE_REFUSED = 'PROVIDER_FILE_REFUSED';
export const isProviderFileKind = (v: unknown): v is ProviderFileKind => typeof v === 'string' && (PROVIDER_FILE_KINDS as readonly string[]).includes(v);

type Client = {
	isConfigured(): boolean;
	inspectIdentityDocument(body: any, opts?: any): Promise<any>;
	inspectSelfie(body: any, opts?: any): Promise<any>;
	inspectCertificate(body: any, opts?: any): Promise<any>;
};
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const join = (...parts: unknown[]) => [...new Set(parts.flat().filter((s): s is string => typeof s === 'string' && !!s.trim()))].join(' — ');

export async function assertProviderFileAcceptable(kind: ProviderFileKind, file: { buffer: Buffer; mimetype: string }, actor: WaseetActor, client: Client, opts: { specialtyName?: string } = {}): Promise<void> {
	const refuse = (message: string, hint: string) => { throw new AppError(`${message || 'الملف غير مناسب لهذا الحقل.'} ${hint}`, 422, undefined, PROVIDER_FILE_REFUSED); };
	if (kind === 'ID_DOCUMENT') {
		const check = await inspectIdentityFile(file, actor, client);
		if (check.verdict === 'REFUSED') refuse(check.messageAr, 'ارفع صورة واضحة لوثيقة هويتك.');
		return;
	}
	const mime = file.mimetype.toLowerCase();
	if (file.buffer.length > IDENTITY_FILE_AI_MAX_BYTES || !client.isConfigured()) return;
	const image = `data:${mime};base64,${file.buffer.toString('base64')}`;
	try {
		if (kind === 'SELFIE') {
			if (!IMAGES.has(mime)) return;
			const r = await client.inspectSelfie({ image, imageMimeType: mime, requireDocument: true }, { actor, timeoutMs: 35_000 });
			if (r?.status === 'NOT_A_SELFIE') refuse(join(r.summaryAr, r.warningsAr), 'التقط صورة شخصية واضحة وأنت تحمل وثيقة هويتك.');
			return;
		}
		if (!IMAGES.has(mime)) return; // certificates: the AI reads pictures (a PDF goes to the human review)
		const r = await client.inspectCertificate({ image, imageMimeType: mime, ...(opts.specialtyName ? { specialtyName: opts.specialtyName } : {}) }, { actor, timeoutMs: 35_000 });
		if (r?.status === 'NOT_CERTIFICATE' || r?.status === 'UNREADABLE') refuse(join(r.summaryAr, r.warningsAr), 'ارفع صورة واضحة للشهادة.');
	} catch (error) {
		if (error instanceof AppError) throw error;
		/* AI unavailable / timed out: accepted, the human review decides */
	}
}
