// POST /api/client/profile/setup: the wizard sends { details, identity, documents, agreements, bank }. Other clients send the same facts under
// other names (top-level bio / interests / idNumber / dob, or the identity number and date of birth inside `identity`). Every KNOWN name is moved
// onto the canonical `details` field and saved; every UNKNOWN name is a 400 that lists it - a field is never accepted with a 200 and silently dropped.

export interface ClientSetupFieldError { path: string; field: string; message: string; code: 'custom' }
const err = (path: string, message: string): ClientSetupFieldError => ({ path, field: path, message, code: 'custom' });

const TOP = ['details', 'identity', 'documents', 'agreements', 'bank', 'paypalPayoutEmail', 'bio', 'interests', 'idNumber', 'dob', 'occupation'];
const DETAILS = ['idNumber', 'dob', 'country', 'city', 'occupation', 'address', 'bio', 'interests'];
const IDENTITY = ['frontId', 'backId', 'idNumber', 'dob'];
const DOCUMENTS = ['supportingDocs', 'notes'];
const AGREEMENTS = ['accurate', 'terms', 'privacy'];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== '';

export function normalizeClientSetupBody(body: unknown): { ok: true; body: Record<string, any> } | { ok: false; errors: ClientSetupFieldError[] } {
  const errors: ClientSetupFieldError[] = [];
  const raw = isObj(body) ? body : {};
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) errors.push(err(k, `الحقل ${k} غير مدعوم ولم يُحفظ`));
  const check = (name: string, allowed: string[]) => {
    const v = raw[name];
    if (isObj(v)) for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(err(`${name}.${k}`, `الحقل ${name}.${k} غير مدعوم ولم يُحفظ`));
  };
  check('details', DETAILS); check('identity', IDENTITY); check('documents', DOCUMENTS); check('agreements', AGREEMENTS);
  if (errors.length) return { ok: false, errors };

  const details: Record<string, any> = isObj(raw.details) ? { ...raw.details } : {};
  const identity: Record<string, any> = isObj(raw.identity) ? { ...raw.identity } : {};
  // the alias wins only when the canonical field is empty
  for (const key of ['bio', 'interests', 'idNumber', 'dob', 'occupation'] as const) {
    const alias = [raw[key], key === 'idNumber' || key === 'dob' ? identity[key] : undefined].find(present);
    if (present(alias) && !present(details[key])) details[key] = alias;
  }
  delete identity.idNumber; delete identity.dob;
  const out: Record<string, any> = { ...raw, details, identity };
  for (const key of ['bio', 'interests', 'idNumber', 'dob', 'occupation']) delete out[key];
  return { ok: true, body: out };
}

export interface ClientSetupCompletenessInput {
  country?: string | null; city?: string | null; industry?: string | null; address?: string | null; idNumber?: string | null; dob?: Date | string | null;
  accurateAgreed?: boolean | null; termsAgreed?: boolean | null; privacyAgreed?: boolean | null;
}
const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** The profile is complete only when every required field is really STORED (read back from the saved row, not assumed from the POST). */
export function isClientSetupComplete(p: ClientSetupCompletenessInput | null | undefined): boolean {
  return !!p && filled(p.country) && filled(p.city) && filled(p.industry) && filled(p.address) && filled(p.idNumber) && !!p.dob
    && p.accurateAgreed === true && p.termsAgreed === true && p.privacyAgreed === true;
}
