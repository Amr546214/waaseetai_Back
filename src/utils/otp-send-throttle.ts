/**
 * Rate limits for the endpoints that SEND a one-time code by email (register, resend-otp, forgot-password and the
 * login-while-unverified resend). They are deliberately separate from the shared `authLimiter` (login, verify, reset...),
 * so that a few wrong passwords can never stop a user from receiving a code, and asking for codes can never lock the
 * verify step.
 *
 * Limits (per the approved decision):
 *  - per recipient (email / user): at most one send every 60 seconds and 5 per hour;
 *  - per IP: 30 send attempts per hour.
 * In-memory sliding windows: the backend runs as a single process, and a restart only resets the counters.
 */
export const OTP_SEND_MIN_INTERVAL_MS = 60 * 1000;
export const OTP_SEND_PER_RECIPIENT_PER_HOUR = 5;
export const OTP_SEND_PER_IP_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

export type OtpThrottleReason = 'interval' | 'recipient-hour' | 'ip-hour';

export interface OtpThrottleResult {
  allowed: boolean;
  /** Seconds the caller must wait (only when not allowed). */
  retryAfterSeconds: number;
  reason?: OtpThrottleReason;
}

/** Arabic wait time: "30 ثانية" / "دقيقتين" / "12 دقيقة" / "ساعة". */
export function formatWaitArabic(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s >= 3600) {
    const h = Math.round(s / 3600);
    return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${h} ساعات`;
  }
  if (s >= 60) {
    const m = Math.ceil(s / 60);
    return m === 1 ? 'دقيقة' : m === 2 ? 'دقيقتين' : `${m} ${m <= 10 ? 'دقائق' : 'دقيقة'}`;
  }
  return `${s} ثانية`;
}

export function otpThrottleMessage(reason: OtpThrottleReason, retryAfterSeconds: number): string {
  const wait = formatWaitArabic(retryAfterSeconds);
  if (reason === 'interval') return `أرسلنا لك رمزًا قبل قليل. انتظر ${wait} قبل طلب رمز جديد، أو استخدم الرمز الذي وصلك.`;
  if (reason === 'recipient-hour') return `وصلت إلى الحد الأقصى لطلبات الرمز لهذا الحساب. حاول مرة أخرى بعد ${wait}.`;
  return `تم تجاوز الحد المسموح لطلبات الرمز من هذا الجهاز. حاول مرة أخرى بعد ${wait}.`;
}

export class OtpSendThrottle {
  private readonly recipients = new Map<string, number[]>();
  private readonly ips = new Map<string, number[]>();

  constructor(
    private readonly options = {
      minIntervalMs: OTP_SEND_MIN_INTERVAL_MS,
      perRecipientPerHour: OTP_SEND_PER_RECIPIENT_PER_HOUR,
      perIpPerHour: OTP_SEND_PER_IP_PER_HOUR,
    }
  ) {}

  private prune(list: number[] | undefined, now: number): number[] {
    return (list ?? []).filter(t => now - t < HOUR_MS);
  }

  /**
   * Checks the three limits and, only when all pass, records this attempt. A rejected attempt is NOT recorded, so asking
   * again early never extends the wait.
   */
  consume(recipientKey: string, ip: string | undefined, now: number = Date.now()): OtpThrottleResult {
    const key = recipientKey.trim().toLowerCase();
    const ipKey = (ip || 'unknown').trim();

    const recipientHits = this.prune(this.recipients.get(key), now);
    const ipHits = this.prune(this.ips.get(ipKey), now);

    const last = recipientHits.length ? recipientHits[recipientHits.length - 1] : null;
    if (last !== null && now - last < this.options.minIntervalMs) {
      return { allowed: false, reason: 'interval', retryAfterSeconds: Math.ceil((this.options.minIntervalMs - (now - last)) / 1000) };
    }
    if (recipientHits.length >= this.options.perRecipientPerHour) {
      return { allowed: false, reason: 'recipient-hour', retryAfterSeconds: Math.ceil((HOUR_MS - (now - recipientHits[0])) / 1000) };
    }
    if (ipHits.length >= this.options.perIpPerHour) {
      return { allowed: false, reason: 'ip-hour', retryAfterSeconds: Math.ceil((HOUR_MS - (now - ipHits[0])) / 1000) };
    }

    recipientHits.push(now);
    ipHits.push(now);
    this.recipients.set(key, recipientHits);
    this.ips.set(ipKey, ipHits);
    this.sweep(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops expired entries once in a while so the maps cannot grow without bound. */
  private sweepCounter = 0;
  private sweep(now: number) {
    if (++this.sweepCounter % 200 !== 0) return;
    for (const map of [this.recipients, this.ips]) {
      for (const [k, list] of map) {
        const kept = this.prune(list, now);
        if (kept.length) map.set(k, kept); else map.delete(k);
      }
    }
  }

  reset() { this.recipients.clear(); this.ips.clear(); }
}

/** The process-wide instance used by the routes and by the login-while-unverified resend. */
export const otpSendThrottle = new OtpSendThrottle();
