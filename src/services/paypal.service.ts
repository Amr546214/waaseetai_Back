// Thin PayPal REST API client — mirrors moyasar.service.ts's shape (native
// fetch, no SDK) but is a fully separate gateway implementation. Never logs
// the client secret, the Authorization header, or any OAuth access token.

export interface PaypalAmount {
  currency_code: string;
  value: string;
}

export interface PaypalCapture {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  amount?: PaypalAmount;
}

export interface PaypalOrderResponse {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: PaypalAmount;
    payments?: {
      captures?: PaypalCapture[];
    };
  }>;
}

export interface VerifyWebhookSignatureParams {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
  webhookEvent: unknown;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// ============================================================================
// Payout P2-B — PayPal Payouts transport (createPayout()) + safe outcome
// classification. Fully additive: shares only getAccessToken()/getBaseUrl()/
// assertConfigured() with the existing deposit/order flow (createOrder/
// captureOrder/getOrder/verifyWebhookSignature, all untouched, still routed
// through the original request<T>() helper). createPayout() deliberately
// does NOT go through request<T>() — that helper throws on a non-2xx and has
// no timeout, neither of which is safe for a call whose whole point is to
// distinguish ACCEPTED / DEFINITELY_REJECTED / UNKNOWN rather than either
// "succeeded" or "threw".
// ============================================================================

/** PayPal Payouts create-batch timeout — an owner decision, not a guess. Also used for the payout-specific bounded OAuth acquisition below (see getAccessTokenForPayout()). */
const PAYOUT_CREATE_TIMEOUT_MS = 15_000;

// Post-financial-safety-review decision: a single top-level PayPal error
// `name` (e.g. "VALIDATION_ERROR") is NOT authoritative enough evidence that
// "PayPal definitely did not create/queue this payout" — that name is
// documented to plausibly span multiple non-equivalent situations (missing/
// invalid fields, bad currency/amount formatting, malformed JSON, account
// status/configuration, business-rule blocks), and this project has no
// bundled PayPal SDK/OpenAPI spec to verify a narrower, granular (e.g.
// details[].issue-level) allowlist against. The asymmetry matters: a false
// UNKNOWN only stalls safely, while a false DEFINITELY_REJECTED would let
// P2-C's markAttemptDefinitelyFailed() reopen the Withdrawal (PROCESSING ->
// APPROVED) and enable a genuinely new PayoutAttempt — i.e. a real risk of
// double-paying a provider if PayPal actually did accept the original
// request. Until a narrowly-audited allowlist is built and approved against
// an authoritative source, createPayout() has NO reachable path that
// returns DEFINITELY_REJECTED — every 4xx is UNKNOWN. The outcome union
// keeps its DEFINITELY_REJECTED member so P2-C/P3 can already be designed
// against its shape; only the runtime classification is withheld here.

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Payout P2-B (post financial-safety review): only these two create-time
// batch statuses are treated as "PayPal accepted this for asynchronous
// processing." DENIED and SUCCESS are deliberately NOT accepted here —
// P2-B's only safe responsibility is recognizing acceptance-for-processing;
// terminal interpretation (a real DENIED rejection, or a real SUCCESS
// completion) belongs to P3's authoritative reconciliation, not to a
// create-time HTTP response alone. An unrecognized/missing/empty status is
// UNKNOWN, never guessed into either bucket.
const ACCEPTED_PAYOUT_BATCH_STATUSES = new Set(['PENDING', 'PROCESSING']);

export interface CreatePayoutParams {
  /** PayoutAttempt-derived idempotency key — reused verbatim, never generated here. */
  senderBatchId: string;
  /** sender_item_id — per the owner decision, this is PayoutAttempt.id. */
  senderItemId: string;
  /** The ONLY source of the destination this method will ever use — the caller (P2-C) owns sourcing it from Withdrawal.paypalEmail. */
  recipientEmail: string;
  /** USD dollars, e.g. 42.5 — normalized to a 2-decimal string internally. Currency is NOT a parameter: always USD. */
  amount: number;
}

/** Bounded, allowlisted fields only — never the receiver/recipient email, never any header or token. Safe to persist later as PayoutAttempt.rawResponse. */
export interface PaypalPayoutSafeResponse {
  httpStatus?: number;
  payoutBatchId?: string;
  batchStatus?: string;
  errorName?: string;
}

export type PaypalPayoutCreateResult =
  | { outcome: 'ACCEPTED'; payoutBatchId: string; batchStatus: string; safeResponse: PaypalPayoutSafeResponse }
  | { outcome: 'DEFINITELY_REJECTED'; reason: string; safeResponse?: PaypalPayoutSafeResponse }
  | { outcome: 'UNKNOWN'; reason: string };

/**
 * Normalizes a positive dollar amount to an exact 2-decimal string ("42.50"),
 * or throws synchronously (before any HTTP call) if it isn't a positive,
 * finite, at-most-2-decimal-place value. Deliberately stricter than
 * createOrder()'s `amount: string` parameter (which trusts an
 * already-normalized caller) — this task's owner decisions require the
 * Payouts transport itself to own this validation.
 */
function normalizePayoutAmount(amount: number): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('createPayout: amount must be a positive finite number');
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    throw new Error('createPayout: amount must be representable in USD with at most two decimal places');
  }
  return (cents / 100).toFixed(2);
}

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`createPayout: ${label} is required`);
  }
}

export class PaypalService {
  private clientId: string;
  private clientSecret: string;
  private env: string;
  private cachedToken: CachedToken | null = null;

  constructor() {
    this.clientId = process.env.PAYPAL_CLIENT_ID || '';
    this.clientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
    this.env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  }

  private assertConfigured(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('بوابة PayPal غير مهيأة: PAYPAL_CLIENT_ID أو PAYPAL_CLIENT_SECRET غير معرّف');
    }
  }

  private getBaseUrl(): string {
    return this.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  /**
   * Client-credentials OAuth token, cached in memory until shortly before
   * expiry. Never logged.
   */
  private async getAccessToken(): Promise<string> {
    this.assertConfigured();

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) {
      return this.cachedToken.accessToken;
    }

    const authHeader = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    const response = await fetch(`${this.getBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`تعذر الاتصال ببوابة PayPal (${response.status})`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000
    };
    return this.cachedToken.accessToken;
  }

  /**
   * Payout P2-B fix (post financial-safety review): a BOUNDED, isolated OAuth
   * acquisition used ONLY by createPayout() — getAccessToken() above is left
   * completely untouched so deposit/order behavior can never change. The
   * problem this fixes: getAccessToken()'s own fetch has no AbortController
   * at all, so a hung OAuth connection would previously leave
   * createPayout()'s returned promise pending forever, never resolving to
   * UNKNOWN despite the payout POST's own 15s timer existing — that timer
   * is only created AFTER getAccessToken() already returns.
   *
   * A still-valid cached token (the SAME this.cachedToken field
   * getAccessToken() reads/writes — reusing it costs no network call and
   * needs no timeout) is returned immediately, with zero behavioral
   * difference from getAccessToken(). Only when a fresh token must actually
   * be fetched does this perform its OWN fetch, with a genuine
   * AbortController tied directly to that fetch's `signal` — a real
   * cancellation of the underlying request, not a Promise.race that would
   * leave the original fetch orphaned and still running in the background.
   */
  private async getAccessTokenForPayout(): Promise<string> {
    this.assertConfigured();

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) {
      return this.cachedToken.accessToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAYOUT_CREATE_TIMEOUT_MS);
    try {
      const authHeader = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      const response = await fetch(`${this.getBaseUrl()}/v1/oauth2/token`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      if (!response.ok) {
        throw new Error(`تعذر الاتصال ببوابة PayPal (${response.status})`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      this.cachedToken = {
        accessToken: data.access_token,
        expiresAt: now + data.expires_in * 1000
      };
      return this.cachedToken.accessToken;
    } finally {
      // Guaranteed cleanup whether the fetch succeeds, rejects, times out, or
      // response parsing throws.
      clearTimeout(timer);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.getBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });

    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message = data?.message || data?.details?.[0]?.description || `خطأ من بوابة PayPal (${response.status})`;
      throw new Error(message);
    }

    return data as T;
  }

  /**
   * Creates a PayPal order (intent CAPTURE). Amount must already be a
   * normalized 2-decimal string (e.g. "50.00") — callers own currency/amount
   * validation before reaching here.
   */
  public async createOrder(params: { amount: string; currency: string; referenceId: string; customId: string }): Promise<PaypalOrderResponse> {
    return this.request<PaypalOrderResponse>('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: params.referenceId,
            custom_id: params.customId,
            amount: { currency_code: params.currency, value: params.amount }
          }
        ]
      })
    });
  }

  public async captureOrder(paypalOrderId: string): Promise<PaypalOrderResponse> {
    return this.request<PaypalOrderResponse>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST'
    });
  }

  public async getOrder(paypalOrderId: string): Promise<PaypalOrderResponse> {
    return this.request<PaypalOrderResponse>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
      method: 'GET'
    });
  }

  /**
   * Payout P2-B: POST /v1/payments/payouts — a single, non-retrying attempt
   * to create one PayPal Payouts batch containing exactly one item. Deliberately
   * bypasses request<T>() (used only by the deposit/order methods above,
   * left byte-for-byte unchanged): that helper throws on any non-2xx and has
   * no timeout, which is wrong here — the whole point of this method is to
   * return a classified outcome (ACCEPTED / DEFINITELY_REJECTED / UNKNOWN),
   * never to let "network trouble" and "PayPal definitively rejected the
   * request" collapse into the same thrown-Error shape.
   *
   * Trust boundary: recipientEmail/senderBatchId/senderItemId/amount all
   * come only from this call's explicit params — never from User.email,
   * never from ProviderProfile, never generated internally. The caller
   * (P2-C) owns sourcing recipientEmail from Withdrawal.paypalEmail and
   * senderBatchId/senderItemId from the existing PayoutAttempt row.
   *
   * Idempotency: uses the EXACT senderBatchId supplied — never derives or
   * regenerates one — and never retries internally. A prior UNKNOWN result
   * must not, by itself, cause a second createPayout() call from anywhere;
   * that decision belongs entirely to P3's future reconciliation/recovery
   * logic, using the SAME senderBatchId semantics this method already
   * respects.
   *
   * `purpose` decision: PayPal's Payouts item schema documents an optional
   * `purpose` enum (e.g. GOODS/SERVICES/...), but this project has no
   * bundled PayPal SDK or OpenAPI spec to verify the exact accepted value
   * set against, and no network access is available to check the live
   * contract. Per this task's own instruction not to guess an unverified
   * enum value, `purpose` is omitted entirely — a minimal, purely financial
   * payload (sender_batch_header + one item's recipient_type/receiver/
   * amount/sender_item_id) is sent instead. Revisit only once the field's
   * exact accepted values are confirmed against an authoritative source.
   */
  public async createPayout(params: CreatePayoutParams): Promise<PaypalPayoutCreateResult> {
    this.assertConfigured();

    // Synchronous, pre-HTTP validation — a caller/programmer error, not a
    // network outcome, so this throws exactly like assertConfigured() does
    // above, rather than resolving to an UNKNOWN/DEFINITELY_REJECTED result.
    assertNonEmpty(params.senderBatchId, 'senderBatchId');
    assertNonEmpty(params.senderItemId, 'senderItemId');
    if (!params.recipientEmail || !SIMPLE_EMAIL_PATTERN.test(params.recipientEmail.trim())) {
      throw new Error('createPayout: recipientEmail is invalid');
    }
    const normalizedAmount = normalizePayoutAmount(params.amount);

    let accessToken: string;
    try {
      // Bounded (15s), isolated from the shared/unbounded getAccessToken()
      // used by deposits — see getAccessTokenForPayout()'s own comment.
      accessToken = await this.getAccessTokenForPayout();
    } catch (error: any) {
      // Never reached the payout call at all — no signal whatsoever about
      // the payout's fate exists, so this is UNKNOWN, never a rejection.
      // This also covers the OAuth acquisition timing out: AbortError is
      // just one more rejection shape caught here, same as any other.
      if (error?.name === 'AbortError') {
        return { outcome: 'UNKNOWN', reason: `انتهت مهلة الحصول على رمز الوصول من PayPal (${PAYOUT_CREATE_TIMEOUT_MS / 1000} ثانية)` };
      }
      return { outcome: 'UNKNOWN', reason: error instanceof Error ? error.message : 'تعذر الحصول على رمز الوصول من PayPal' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAYOUT_CREATE_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.getBaseUrl()}/v1/payments/payouts`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender_batch_header: {
              sender_batch_id: params.senderBatchId,
              recipient_type: 'EMAIL'
            },
            items: [
              {
                recipient_type: 'EMAIL',
                receiver: params.recipientEmail,
                amount: { value: normalizedAmount, currency: 'USD' },
                sender_item_id: params.senderItemId
              }
            ]
          })
        });
      } catch (error: any) {
        // Timeout (AbortController firing) and any other transport-level
        // failure (DNS/socket/network) are BOTH UNKNOWN — PayPal never
        // actually responded either way, so there is no basis to declare a
        // definite rejection.
        if (error?.name === 'AbortError') {
          return { outcome: 'UNKNOWN', reason: `انتهت مهلة الاتصال ببوابة PayPal للتحويل (${PAYOUT_CREATE_TIMEOUT_MS / 1000} ثانية)` };
        }
        return { outcome: 'UNKNOWN', reason: 'تعذر الاتصال ببوابة PayPal للتحويل' };
      }

      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null; // unparseable body — handled by the shape checks below, never assumed to mean anything.
      }

      if (response.ok) {
        const payoutBatchId = data?.batch_header?.payout_batch_id;
        const rawBatchStatus = data?.batch_header?.batch_status;
        // Normalize (trim + uppercase) before comparing — guards against
        // incidental whitespace/casing without ever loosening the check
        // into accepting an arbitrary string: it still must match one of
        // ACCEPTED_PAYOUT_BATCH_STATUSES exactly after normalization.
        const batchStatus = typeof rawBatchStatus === 'string' ? rawBatchStatus.trim().toUpperCase() : undefined;
        if (typeof payoutBatchId === 'string' && payoutBatchId && batchStatus && ACCEPTED_PAYOUT_BATCH_STATUSES.has(batchStatus)) {
          return {
            outcome: 'ACCEPTED',
            payoutBatchId,
            batchStatus,
            safeResponse: { httpStatus: response.status, payoutBatchId, batchStatus }
          };
        }
        // HTTP success but either the payout-batch identifier is missing,
        // or the batch status isn't one of the two create-time
        // "accepted for asynchronous processing" statuses P2-B recognizes
        // (PENDING/PROCESSING) — this deliberately includes a missing
        // status, an unrecognized one, AND the known terminal ones
        // (DENIED/SUCCESS): a successful HTTP response does NOT by itself
        // mean the payout is confirmed accepted (owner decision), and P2-B
        // has no business declaring a terminal outcome — that's P3's job.
        return { outcome: 'UNKNOWN', reason: 'استجابة ناجحة من PayPal دون هوية أو حالة دفعة تحويل صالحة للقبول المبدئي' };
      }

      if (response.status >= 400 && response.status < 500) {
        // See the module-level comment above ACCEPTED_PAYOUT_BATCH_STATUSES/
        // this section's own top for the full reasoning: no 4xx shape is
        // currently trusted enough to classify as DEFINITELY_REJECTED.
        return { outcome: 'UNKNOWN', reason: `استجابة برمز حالة 4xx من بوابة PayPal (${response.status}) — لا يوجد دليل موثوق كافٍ لاعتباره رفضاً نهائياً` };
      }

      // 5xx (or any other unexpected status) — always UNKNOWN.
      return { outcome: 'UNKNOWN', reason: `خطأ من خادم PayPal (${response.status})` };
    } finally {
      // Guaranteed cleanup on every path above: success, transport error,
      // or any exception thrown while parsing/classifying the response.
      clearTimeout(timer);
    }
  }

  /**
   * Verifies webhook authenticity via PayPal's official verification API.
   * This is the ONLY thing that may treat a webhook payload as trustworthy —
   * never process an event without a SUCCESS result from this call.
   */
  public async verifyWebhookSignature(params: VerifyWebhookSignatureParams): Promise<boolean> {
    this.assertConfigured();
    const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
    if (!webhookId) {
      throw new Error('بوابة PayPal غير مهيأة: PAYPAL_WEBHOOK_ID غير معرّف');
    }

    const result = await this.request<{ verification_status: 'SUCCESS' | 'FAILURE' }>('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        transmission_id: params.transmissionId,
        transmission_time: params.transmissionTime,
        cert_url: params.certUrl,
        auth_algo: params.authAlgo,
        transmission_sig: params.transmissionSig,
        webhook_id: webhookId,
        webhook_event: params.webhookEvent
      })
    });

    return result.verification_status === 'SUCCESS';
  }
}

export const paypalService = new PaypalService();
