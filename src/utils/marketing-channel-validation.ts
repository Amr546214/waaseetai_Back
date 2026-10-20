// Marketing channel validity for the marketer SETUP wizard (a channel is "valid" when it can really be a channel of its platform). The same rules are mirrored in the frontend
// (core/utils/marketing-channel.ts); no platform is forced and one channel is enough.
//  - the value has no spaces;
//  - a link (starts with http(s):// or contains a «/») must be an http(s) URL on that platform's own domains;
//  - otherwise it is a handle: WhatsApp = a phone number (digits, optional +, 7-15 digits), the others = letters / digits / . _ - with an optional leading @.

export type MarketingPlatform = 'LINKEDIN' | 'YOUTUBE' | 'TIKTOK' | 'WHATSAPP' | 'TWITTER' | 'INSTAGRAM';

const HOSTS: Record<MarketingPlatform, string[]> = {
  LINKEDIN: ['linkedin.com'],
  YOUTUBE: ['youtube.com', 'youtu.be'],
  TIKTOK: ['tiktok.com'],
  WHATSAPP: ['wa.me', 'whatsapp.com'],
  TWITTER: ['twitter.com', 'x.com'],
  INSTAGRAM: ['instagram.com'],
};

/** null when valid, else the Arabic message to show under the channel field. */
export function marketingChannelProblem(platform: string, rawHandle: string): string | null {
  const handle = String(rawHandle ?? '').trim();
  if (!handle) return 'معرّف القناة مطلوب';
  if (/\s/.test(handle)) return 'معرّف القناة لا يجوز أن يحتوي على مسافات';
  const key = String(platform ?? '').toUpperCase() as MarketingPlatform;
  const hosts = HOSTS[key];
  if (!hosts) return null; // an unknown platform is refused by its own rule
  if (/^https?:\/\//i.test(handle) || handle.includes('/')) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(handle) && !/^https?:\/\//i.test(handle)) return 'رابط القناة يجب أن يبدأ بـ http أو https';
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(handle) ? handle : `https://${handle}`); } catch { return 'رابط القناة غير صالح'; }
    if (!['http:', 'https:'].includes(url.protocol)) return 'رابط القناة يجب أن يبدأ بـ http أو https';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return hosts.some(d => host === d || host.endsWith(`.${d}`)) ? null : 'الرابط لا يخص هذا النوع من القنوات';
  }
  if (key === 'WHATSAPP') return /^\+?\d{7,15}$/.test(handle) ? null : 'أدخل رقم واتساب صالحًا (أرقام فقط، مع + اختياريًا)';
  return /^@?[\p{L}\p{N}._-]{1,100}$/u.test(handle) ? null : 'معرّف القناة غير صالح: أحرف وأرقام ونقطة وشرطة فقط';
}
