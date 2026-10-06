// MIME allow-lists for the upload routes that previously had none (specialty samples/proofs, chat attachments).
// Parameters such as ";codecs=opus" are ignored when matching (see memoryUpload).

const IMAGES = ['image/png', 'image/jpeg', 'image/webp'];
const PDF = ['application/pdf'];
const OFFICE_DOCS = [
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];
const ZIP = ['application/zip', 'application/x-zip-compressed'];
const VOICE_NOTES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/x-m4a', 'audio/aac'];

/** Work-sample files and ownership proofs submitted from the specialty wizard (the wizard offers image/pdf/doc/docx/zip). */
export const SPECIALTY_UPLOAD_MIME_TYPES = new Set([...IMAGES, ...PDF, ...OFFICE_DOCS.slice(0, 2), ...ZIP]);

/** Chat attachments: pictures, documents and recorded voice notes. */
export const CHAT_UPLOAD_MIME_TYPES = new Set([...IMAGES, 'image/gif', ...PDF, ...OFFICE_DOCS, ...ZIP, ...VOICE_NOTES]);
