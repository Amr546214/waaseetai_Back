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

export function validDocumentNumber(value: string, doc?: IdentityDocument): boolean {
  return !doc || (doc.country === 'EG' && doc.type === 'NATIONAL_ID')
    ? /^\d{14}$/.test(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15)))
    : /^[\p{L}\p{Nd}][\p{L}\p{Nd} /.-]{0,39}$/u.test(value);
}

export function documentUpdate(input: Fields, stored?: Fields | null) {
  const doc = identityDocumentContext(input);
  const effective = doc ?? (stored ? identityDocumentContext(stored) : undefined);
  const number = input.idNumber || stored?.idNumber;
  if (effective && (doc || input.idNumber) && (typeof number !== 'string' || !validDocumentNumber(number.trim(), effective))) {
    throw new AppError('رقم الوثيقة غير صالح لبلد الإصدار ونوع الوثيقة', 400);
  }
  if (!effective && input.idNumber && (typeof input.idNumber !== 'string' || !/^[12]\d{9}$/.test(input.idNumber))) {
    throw new AppError('رقم الهوية يجب أن يكون 10 أرقام ويبدأ بـ 1 أو 2', 400);
  }
  return doc ? { idIssuingCountry: doc.country, idDocumentType: doc.type } : {};
}
