// Arabic texts of the phone-change flow (AUD-FND-000026), in their own file so profile.service can use them without loading the mail stack.
export const PHONE_CHANGE_REQUIRED_MESSAGE = 'تغيير رقم الجوال يتطلب رمز تحقق يصل إلى بريدك الإلكتروني';
export const PHONE_CHANGE_SAME_NUMBER_MESSAGE = 'هذا هو رقم جوالك الحالي بالفعل';
export const PHONE_CHANGE_INVALID_CODE_MESSAGE = 'رمز التحقق غير صحيح';
export const PHONE_CHANGE_EXPIRED_MESSAGE = 'انتهت صلاحية رمز التحقق أو لم يُطلب رمز، اطلب رمزًا جديدًا';
// The same text as a duplicate number on a profile save (#26): it never says that the number belongs to someone else.
export const PHONE_CHANGE_GENERIC_CONFLICT = 'تعذر حفظ رقم الجوال، تأكد من الرقم أو جرّب رقمًا آخر';

