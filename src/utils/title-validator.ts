/**
 * Verifies if a project title or text is meaningful and not random gibberish / spam.
 */
export function isMeaningfulProjectTitle(title: string): { valid: boolean; reason?: string } {
  if (!title || typeof title !== 'string') {
    return { valid: false, reason: 'يرجى إدخال اسم المشروع أولاً' };
  }

  const trimmed = title.trim();

  // 1. Minimum length
  if (trimmed.length < 4) {
    return { valid: false, reason: 'اسم المشروع قصير جداً (أقل من 4 أحرف)، يرجى كتابة عنوان واضح ومحدد' };
  }

  // 2. Must contain letters (Arabic or Latin)
  const hasLetters = /[\p{L}]/u.test(trimmed);
  if (!hasLetters) {
    return { valid: false, reason: 'يجب أن يحتوي اسم المشروع على حروف وكلمات مفهومة وليس أرقاماً أو رموزاً فقط' };
  }

  // 3. Excessive repeated character check (e.g. "aaaaa", "11111", "ششششش")
  if (/(.)\1{3,}/u.test(trimmed)) {
    return { valid: false, reason: 'اسم المشروع يحتوي على حروف مكررة بشكل عشوائي، يرجى كتابة اسم مشروع مهني وحقيقي' };
  }

  // 4. Repeated short pattern check (e.g. "شسيشسيشسي", "abababab")
  const cleaned = trimmed.replace(/\s+/g, '');
  if (/^(.{2,4})\1{2,}$/iu.test(cleaned)) {
    return { valid: false, reason: 'اسم المشروع يحتوي على نمط متكرر عشوائي، يرجى إدخال عنوان مهني واضح' };
  }

  // 5. English gibberish / consonant smash detection (e.g. "fhjdfhjfhdjfdhjdjhdkjhfdjhfdkjhfdkjhff")
  const words = trimmed.split(/\s+/);
  for (const word of words) {
    if (/^[A-Za-z]+$/.test(word)) {
      // If long word with high consonant sequence (>= 5 consonants in a row)
      if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(word)) {
        return { valid: false, reason: 'اسم المشروع يبدو نصاً عشوائياً غير مفهوم. يرجى إدخال اسم مهني واضح (مثل: "تطوير متجر إلكتروني" أو "تصميم هوية بصرية")' };
      }
      // If word is 6+ chars and has almost no vowels (vowel ratio < 15%)
      if (word.length >= 6) {
        const vowelsCount = (word.match(/[aeiouy]/gi) || []).length;
        if (vowelsCount / word.length < 0.15) {
          return { valid: false, reason: 'اسم المشروع غير مفهوم. يرجى كتابة عنوان مشروع حقيقي باللغة العربية أو الإنجليزية' };
        }
      }
    }
  }

  // 6. Arabic gibberish (keyboard row smashing like "سشيشسيبشسي")
  if (words.length === 1 && cleaned.length >= 10 && !isStandardArabicWord(cleaned)) {
    const commonChars = new Set(cleaned.split(''));
    if (commonChars.size <= 4) {
      return { valid: false, reason: 'اسم المشروع غير مفهوم أو عشوائي. يرجى إدخال اسم مشروع واضح ومعبر' };
    }
  }

  return { valid: true };
}

function isStandardArabicWord(word: string): boolean {
  const commonPrefixes = ['المشروع', 'الخدمة', 'التطوير', 'التصميم', 'البرمجة', 'الاستشارة', 'التسويق', 'إدارة', 'إنشاء', 'تطوير', 'تصميم', 'برمجة', 'تسويق'];
  return commonPrefixes.some(p => word.startsWith(p));
}
