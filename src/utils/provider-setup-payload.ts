import { isBlankText } from './sanitize-text';
// POST /api/provider/profile/setup: the payload is nested ({ details, specialties, identity, documents, agreements, portfolio, skills }).
// Some clients send the same facts under other names (top-level headline / hourlyRate / yearsOfExperience / mainSpecialty, or the identity
// number / date of birth inside `identity`). Every KNOWN name is mapped onto the one canonical field and saved; every UNKNOWN name is a
// 400 that lists it - a field is never accepted with a 200 and then silently dropped.

export interface SetupFieldError { path: string; field: string; message: string; code: 'custom' }
const err = (path: string, message: string): SetupFieldError => ({ path, field: path, message, code: 'custom' });

const TOP_KEYS = ['details', 'specialties', 'identity', 'documents', 'agreements', 'portfolio', 'skills', 'bank',
  'headline', 'hourlyRate', 'yearsOfExperience', 'mainSpecialty', 'subSpecialties', 'idNumber', 'dob', 'avatarUrl'];
const DETAILS_KEYS = ['occupation', 'headline', 'country', 'city', 'address', 'bio', 'languages', 'expYears', 'yearsOfExperience', 'hourlyRate', 'idNumber', 'dob'];
const IDENTITY_KEYS = ['frontId', 'backId', 'certs', 'idNumber', 'dob'];
const SPECIALTY_KEYS = ['mainSpec', 'subSpecs', 'mainSpecialty', 'subSpecialties'];
const DOCUMENT_KEYS = ['supportingDocs', 'notes'];
const AGREEMENT_KEYS = ['accurate', 'terms', 'privacy'];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== '';
const firstPresent = (...vs: unknown[]) => vs.find(present);

export const ID_NUMBER_RE = /^[12]\d{9}$/;

export interface NormalizedProviderSetup {
  details: Record<string, any>;
  specialties: Record<string, any>;
  identity: Record<string, any>;
  documents: Record<string, any>;
  agreements: Record<string, any>;
  hourlyRate: number | undefined;
  /** The profile photo the wizard uploaded (our Cloudinary URL, or an image data URI the controller re-stores). undefined = keep the stored one. */
  avatarUrl: string | undefined;
  /** A number of years, or undefined when the payload did not state it (the stored value is then kept). */
  yearsOfExperience: number | undefined;
}

export function normalizeProviderSetupPayload(body: unknown): { ok: true; value: NormalizedProviderSetup } | { ok: false; errors: SetupFieldError[] } {
  const errors: SetupFieldError[] = [];
  const raw = isObj(body) ? body : {};
  const section = (name: string, allowed: string[]): Record<string, any> => {
    const v = raw[name];
    if (v === undefined || v === null) return {};
    if (!isObj(v)) { errors.push(err(name, `الحقل ${name} يجب أن يكون كائنًا`)); return {}; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(err(`${name}.${k}`, `الحقل ${name}.${k} غير مدعوم ولم يُحفظ`));
    return v;
  };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(err(k, `الحقل ${k} غير مدعوم ولم يُحفظ`));
  const details = section('details', DETAILS_KEYS);
  const specialties = section('specialties', SPECIALTY_KEYS);
  const identity = section('identity', IDENTITY_KEYS);
  const documents = section('documents', DOCUMENT_KEYS);
  const agreements = section('agreements', AGREEMENT_KEYS);

  const out: Record<string, any> = { ...details };
  // headline (the wizard calls it "occupation")
  const headline = firstPresent(details.occupation, details.headline, raw.headline);
  if (present(headline)) { if (typeof headline !== 'string') errors.push(err('headline', 'المسمى الوظيفي يجب أن يكون نصًا')); else out.occupation = headline; }

  // years of experience: a number, or the wizard's range label (expYears)
  let yearsOfExperience: number | undefined;
  const years = firstPresent(details.yearsOfExperience, raw.yearsOfExperience);
  if (present(years)) {
    const n = typeof years === 'number' ? years : Number(years);
    if (!Number.isFinite(n) || n < 0 || n > 70) errors.push(err('yearsOfExperience', 'سنوات الخبرة يجب أن تكون رقمًا بين 0 و70'));
    else yearsOfExperience = Math.round(n);
  } else if (present(details.expYears)) {
    const label = String(details.expYears);
    const map: Record<string, number> = { 'أقل من سنة': 1, '1 الى 3 سنوات': 2, '3 الى 5 سنوات': 4, '5 الى 10 سنوات': 7, 'أكثر من 10 سنوات': 10 };
    const n = label in map ? map[label] : parseInt(label, 10);
    if (!Number.isFinite(n)) errors.push(err('details.expYears', 'قيمة سنوات الخبرة غير مفهومة'));
    else yearsOfExperience = n;
  }

  let hourlyRate: number | undefined;
  const rate = firstPresent(details.hourlyRate, raw.hourlyRate);
  if (present(rate)) {
    const n = typeof rate === 'number' ? rate : Number(rate);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) errors.push(err('hourlyRate', 'السعر بالساعة يجب أن يكون رقمًا موجبًا'));
    else hourlyRate = n;
  }

  // specialties
  const main = firstPresent(specialties.mainSpec, specialties.mainSpecialty, raw.mainSpecialty);
  const subs = firstPresent(specialties.subSpecs, specialties.subSpecialties, raw.subSpecialties);
  const outSpecialties: Record<string, any> = { ...specialties };
  if (present(main)) { if (typeof main !== 'string') errors.push(err('mainSpecialty', 'التخصص الرئيسي يجب أن يكون نصًا')); else outSpecialties.mainSpec = main; }
  if (subs !== undefined) { if (!Array.isArray(subs)) errors.push(err('subSpecialties', 'التخصصات الفرعية يجب أن تكون قائمة')); else outSpecialties.subSpecs = subs; }

  // identity number / date of birth: accepted under details, identity or top level; one canonical place (the KYC-guarded profile columns)
  const idNumber = firstPresent(details.idNumber, identity.idNumber, raw.idNumber);
  if (present(idNumber)) {
    if (typeof idNumber !== 'string' || !ID_NUMBER_RE.test(idNumber.trim())) errors.push(err('idNumber', 'رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2'));
    else out.idNumber = idNumber.trim();
  }
  const dob = firstPresent(details.dob, identity.dob, raw.dob);
  if (present(dob)) {
    const d = new Date(dob as any);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() || d.getFullYear() < 1900) errors.push(err('dob', 'تاريخ الميلاد غير صالح'));
    else out.dob = d.toISOString();
  }

  // profile photo: a non-empty string only; '' / null mean "keep what is stored". The controller verifies that it is our own storage.
  let avatarUrl: string | undefined;
  if (present(raw.avatarUrl)) {
    if (typeof raw.avatarUrl !== 'string' || raw.avatarUrl.length > 12_000_000) errors.push(err('avatarUrl', 'الصورة الشخصية غير صالحة'));
    else avatarUrl = raw.avatarUrl;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { details: out, specialties: outSpecialties, identity, documents, agreements, hourlyRate, yearsOfExperience, avatarUrl } };
}

export interface ProviderSetupCompletenessInput {
  headline?: string | null; country?: string | null; city?: string | null; bio?: string | null; mainSpecialty?: string | null;
  yearsOfExperience?: number | null; accurateAgreed?: boolean | null; termsAgreed?: boolean | null; privacyAgreed?: boolean | null;
}
const filled = (v: unknown) => typeof v === 'string' && !isBlankText(v);

/** Setup is complete only when every required field is really STORED (read back from the saved profile, never from the request). */
export function isProviderSetupComplete(p: ProviderSetupCompletenessInput | null | undefined): boolean {
  return !!p && filled(p.headline) && filled(p.country) && filled(p.city) && filled(p.bio) && filled(p.mainSpecialty)
    && typeof p.yearsOfExperience === 'number' && p.accurateAgreed === true && p.termsAgreed === true && p.privacyAgreed === true;
}

export interface ProviderSetupEvidenceInput {
  subSpecialties?: string[] | null; frontIdUrl?: string | null; kycStatus?: string | null;
  portfolioItems?: Array<{ title?: string | null; description?: string | null; tags?: string[] | null }> | null;
}

/**
 * The stored EVIDENCE a finished setup rests on (read back from the saved profile, never from the request): at least one sub-specialty, the identity front on file
 * (or a review already running / decided), and for EVERY chosen sub-specialty a stored model with its file and at least one stored proof of ownership.
 * The setup is marked complete only when this holds as well, so no request shape (with or without `portfolio`) can complete it without documents.
 */
export function providerSetupEvidenceComplete(p: ProviderSetupEvidenceInput | null | undefined): boolean {
  if (!p) return false;
  const subs = (p.subSpecialties ?? []).filter(s => typeof s === 'string' && s.trim());
  if (subs.length === 0) return false;
  if (!(filled(p.frontIdUrl) || p.kycStatus === 'PENDING' || p.kycStatus === 'VERIFIED')) return false;
  const specOf = (title?: string | null) => String(title ?? '').replace(/^نموذج أعمال\s*-\s*/, '').trim();
  const withProof = new Set((p.portfolioItems ?? []).filter(i => filled(i?.description) && (i?.tags ?? []).some(t => filled(t))).map(i => specOf(i?.title)));
  return subs.every(s => withProof.has(s.trim()));
}
