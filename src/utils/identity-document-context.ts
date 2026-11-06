import { AppError } from './app-error';

export const documentTypes = ['NATIONAL_ID', 'PASSPORT', 'RESIDENCE_PERMIT', 'DRIVING_LICENCE'] as const;
export type IdentityDocument = { country: string; type: typeof documentTypes[number] };
type Fields = { idNumber?: unknown; idIssuingCountry?: unknown; idDocumentType?: unknown };

export function identityDocumentContext(input: Fields): IdentityDocument | undefined {
  const { idIssuingCountry: country, idDocumentType: type } = input;
  if ((country == null || country === '') && (type == null || type === '')) return;
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || !documentTypes.some(value => value === type)) {
    throw new AppError('اختر بلد إصدار الوثيقة ونوعها', 400);
  }
  return { country, type: type as IdentityDocument['type'] };
}

// National ID formats: UAE ICP, Kuwait CSB, Qatar MCIT, Bahrain SIO.
const nationalIdFormats: Readonly<Record<string, { pattern: RegExp; message: string }>> = {
  AE: { pattern: /^(?:784\d{12}|784-\d{4}-\d{7}-\d)$/, message: 'رقم الهوية الإماراتية لازم يكون 15 رقمًا ويبدأ بـ 784' },
  KW: { pattern: /^\d{12}$/, message: 'الرقم المدني الكويتي لازم يكون 12 رقمًا' },
  QA: { pattern: /^\d{11}$/, message: 'رقم الهوية القطرية لازم يكون 11 رقمًا' },
  BH: { pattern: /^\d{9}$/, message: 'الرقم الشخصي البحريني لازم يكون 9 أرقام' },
};

const egyptianBirthCodes = new Set('01 02 03 04 11 12 13 14 15 16 17 18 19 21 22 23 24 25 26 27 28 29 31 32 33 34 35 88'.split(' '));

// Turkish T.C. Kimlik No: the last two digits are computed from the first nine.
function validTurkishNationalId(value: string): boolean {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const digits = Array.from(value, Number);
  const odd = digits[0] + digits[2] + digits[4] + digits[6] + digits[8];
  const even = digits[1] + digits[3] + digits[5] + digits[7];
  return digits[9] === ((7 * odd - even) % 10 + 10) % 10 &&
    digits[10] === digits.slice(0, 10).reduce((sum, d) => sum + d, 0) % 10;
}

function egyptianIdStructure(value: string): 'CENTURY' | 'DATE' | 'BIRTH_CODE' | null {
  if (!/^[23]/.test(value)) return 'CENTURY';
  const year = (value[0] === '2' ? 1900 : 2000) + Number(value.slice(1, 3));
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day && date.getTime() <= Date.now() ? (egyptianBirthCodes.has(value.slice(7, 9)) ? null : 'BIRTH_CODE') : 'DATE';
}

export function validDocumentNumber(value: string, doc?: IdentityDocument): boolean {
  if (doc?.country === 'TR' && doc.type === 'NATIONAL_ID') {
    return validTurkishNationalId(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15)));
  }
  const format = doc?.type === 'NATIONAL_ID' ? nationalIdFormats[doc.country] : undefined;
  if (format) return format.pattern.test(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15)));
  if (doc?.country === 'SA' && (doc.type === 'NATIONAL_ID' || doc.type === 'RESIDENCE_PERMIT')) {
    const normalized = value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15));
    return (doc.type === 'NATIONAL_ID' ? /^1\d{9}$/ : /^2\d{9}$/).test(normalized);
  }
  return !doc || (doc.country === 'EG' && doc.type === 'NATIONAL_ID')
    ? /^\d{14}$/.test(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15))) &&
      egyptianIdStructure(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15))) === null
    : /^[\p{L}\p{Nd}][\p{L}\p{Nd} /.-]{0,39}$/u.test(value);
}

export function documentUpdate(input: Fields, stored?: Fields | null) {
  const doc = identityDocumentContext(input);
  const effective = doc ?? (stored ? identityDocumentContext(stored) : undefined);
  const number = input.idNumber || stored?.idNumber;
  if (effective && (doc || input.idNumber) && (typeof number !== 'string' || !validDocumentNumber(number.trim(), effective))) {
    const format = effective.type === 'NATIONAL_ID' ? nationalIdFormats[effective.country] : undefined;
    if (format) throw new AppError(format.message, 400);
    if (effective.country === 'SA' && (effective.type === 'NATIONAL_ID' || effective.type === 'RESIDENCE_PERMIT')) {
      throw new AppError(effective.type === 'NATIONAL_ID' ? 'رقم الهوية السعودية لازم يكون 10 أرقام ويبدأ بـ 1' : 'رقم الإقامة السعودية لازم يكون 10 أرقام ويبدأ بـ 2', 400);
    }
    throw new AppError('رقم الوثيقة غير صالح لبلد الإصدار ونوع الوثيقة', 400);
  }
  if (!effective && input.idNumber && (typeof input.idNumber !== 'string' || !/^[12]\d{9}$/.test(input.idNumber))) {
    throw new AppError('رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2', 400);
  }
  return doc ? { idIssuingCountry: doc.country, idDocumentType: doc.type } : {};
}
