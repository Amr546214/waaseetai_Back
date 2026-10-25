/**
 * The platform name as shown in NEW e-mails (header, footer, document title, default subjects). Set by the settings service whenever it reads the `platformName` setting; empty = the built-in name.
 * E-mails already sent and stored documents keep the name they were produced with - nothing here rewrites history.
 */
export const DEFAULT_BRAND = 'Waseet AI';
let current = '';
export const setBrandName = (name: unknown) => { current = typeof name === 'string' ? name.trim() : ''; };
export const brandName = (): string => current || DEFAULT_BRAND;
/** a default subject written "… - Waseet AI" carries the configured name instead; a subject that does not end with the built-in brand (an env override) is left exactly as configured */
export const brandSubject = (subject: string): string => (subject.endsWith(` - ${DEFAULT_BRAND}`) ? `${subject.slice(0, -DEFAULT_BRAND.length)}${brandName()}` : subject);
/** the name inside Arabic prose: the built-in Arabic brand until a name is configured */
export const brandNameInArabicText = (): string => (current ? current : 'وسيط AI');
