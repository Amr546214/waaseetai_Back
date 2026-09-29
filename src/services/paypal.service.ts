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

// ============================================================================
// Payout P3-B — GET-by-batch-id transport (getPayoutBatch()) + idempotent
// senderBatchId resubmission/recovery transport (recoverPayoutBySenderBatch()).
// Both are TRANSPORT ONLY: neither makes any DB call, neither decides
// financial completion, neither retries automatically. Shares only
// getAccessTokenForPayout()/getBaseUrl()/assertConfigured() with P2-B's
// createPayout() — the deposit/order flow above remains completely untouched.
// ============================================================================

// SANDBOX CHARACTERIZATION ITEM: this project's confirmed official PayPal
// contract does not establish payout_batch_id's complete character set or
// length, so this pattern is a deliberately conservative, defensively
// strict guess — NOT verified against an authoritative PayPal ID-format
// spec (none is bundled in this project). Restricting to a plain
// alphanumeric charset can only ever cause an overly-cautious rejection of
// a real id this project hasn't seen the shape of yet (a safe, visible
// UNKNOWN/thrown-validation-error), never an injection/path-traversal risk
// — the asymmetry that justifies keeping this strict rather than loosening
// it on speculation. It is safer for P3-B to return UNKNOWN for an
// unfamiliar legitimate id than to accept unsafe path material. Do NOT
// loosen this pattern without empirical Sandbox evidence of real
// payout_batch_id values; revisit only once that evidence exists.
const PAYOUT_BATCH_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

// The full documented PayPal Payouts ITEM transaction-status set (STEP 7 of
// the confirmed official contract). getPayoutBatch() recognizes ONLY these —
// anything else (missing, unrecognized, malformed) is left undefined in the
// returned typed result, NEVER guessed into SUCCESS/FAILED/any other value.
const KNOWN_ITEM_TRANSACTION_STATUSES = new Set([
  'SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED'
]);

export interface PaypalPayoutItemResult {
  payoutItemId?: string;
  payoutBatchId: string;
  /** The item's own sender_item_id, if present in PayPal's response — lets a future caller correlate this item back to a specific PayoutAttempt.id. */
  senderItemId?: string;
  /** Normalized (trim+uppercase), and ONLY if it matches KNOWN_ITEM_TRANSACTION_STATUSES — undefined if missing/unrecognized. This transport layer never maps an unknown value to any financial state. */
  transactionStatus?: string;
}

export interface PaypalGetPayoutBatchResult {
  payoutBatchId: string;
  /**
   * Informational only. P3-B (and any future caller) must NEVER treat this
   * as authoritative evidence of financial completion — including a value
   * of "SUCCESS" — per the owner decision that only ITEM-level
   * transactionStatus is the financial-reconciliation input. Normalized
   * (trim+uppercase) if present and non-empty, else undefined; no allowlist
   * filtering is applied here since nothing safety-relevant depends on its
   * exact value.
   */
  batchStatus?: string;
  senderBatchId?: string;
  items: PaypalPayoutItemResult[];
}

export type PaypalGetPayoutBatchOutcome =
  | { outcome: 'FOUND'; batch: PaypalGetPayoutBatchResult }
  | { outcome: 'UNKNOWN'; reason: string };

export interface RecoverPayoutBySenderBatchParams {
  /** Reused verbatim — never generated/derived here. Must be the EXACT senderBatchId already used for the original createPayout() attempt. */
  senderBatchId: string;
  senderItemId: string;
  recipientEmail: string;
  amount: number;
}

/**
 * Post-review semantic clarification (financial-safety-critical — read
 * before using this type anywhere): `{ outcome: 'RECOVERED', payoutBatchId }`
 * means ONLY "we have safely obtained the PayPal payout_batch_id
 * corresponding to this same sender_batch_id recovery operation." It NEVER
 * means, and must never be treated by any caller as meaning:
 *   - the payout succeeded or completed
 *   - the recipient received funds
 *   - the item's transaction_status is SUCCESS (or any other specific value)
 *   - Withdrawal should become COMPLETED
 *   - PayoutAttempt should become COMPLETED
 * Both ways RECOVERED can be produced — a fresh 2xx acceptance, or a
 * structurally-proven duplicate-response HATEOAS link — recover IDENTITY
 * ONLY. A future P3-C MUST still call getPayoutBatch(payoutBatchId) and
 * inspect the specific item's transaction_status before making any
 * financial-state decision; recoverPayoutBySenderBatch() itself never
 * inspects or reports item-level status at all.
 */
export type PaypalRecoverPayoutResult =
  | { outcome: 'RECOVERED'; payoutBatchId: string }
  | { outcome: 'UNKNOWN'; reason: string };

/**
 * Payout P3-B recovery transport: extracts the original payout's
 * payoutBatchId from a PayPal duplicate-sender_batch_id error response's
 * HATEOAS `links` array — and ONLY from there. This function NEVER fetches
 * or follows any URL; a candidate href is treated purely as a string to
 * parse and validate, never dereferenced (see recoverPayoutBySenderBatch()'s
 * own SSRF-safety comment and this project's STEP 13 security review).
 *
 * Deliberately conservative, per explicit instruction: the exact real
 * Sandbox shape of PayPal's duplicate-sender_batch_id response (its HTTP
 * status, error `name`, `details[].issue`, and HATEOAS `rel` value) has NOT
 * been empirically characterized against a real Sandbox call in this
 * project, and no authoritative local spec exists to confirm it. This
 * parser therefore trusts NOTHING about the response body's free-text
 * fields (`name`, `message`, `details`) — only a structurally well-formed
 * link whose origin matches OUR OWN already-configured, trusted PayPal base
 * URL, and whose path matches the exact known payouts-batch resource shape
 * (`/v1/payments/payouts/{id}`), can ever produce a recovered id. Any link
 * with an unexpected origin, an unexpected path, or an `{id}` segment that
 * fails the same strict validation getPayoutBatch() itself requires, is
 * ignored — no `rel` value is required (its real value is unverified), only
 * the origin+path+id are ever trusted. Absence of such a link means NO
 * recovery — never guessed from anything else in the response.
 */
function extractOriginalPayoutBatchIdFromDuplicateResponse(data: any, trustedBaseUrl: string): string | null {
  const links = Array.isArray(data?.links) ? data.links : [];

  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(trustedBaseUrl).origin;
  } catch {
    return null;
  }

  for (const link of links) {
    const href = link?.href;
    if (typeof href !== 'string' || !href) continue;

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue; // malformed href — never partially trusted.
    }

    // The ONE hard SSRF-relevant boundary: only our own already-configured,
    // trusted PayPal API origin is ever accepted — exactly the same
    // sandbox/live selection this service already makes for every other
    // call. A link pointing anywhere else (including a convincing-looking
    // lookalike domain) is rejected outright, unconditionally.
    if (parsed.origin !== trustedOrigin) continue;

    // Exact expected resource path shape only — /v1/payments/payouts/{id} —
    // with nothing else after the id (no unexpected sub-resource/traversal).
    const match = parsed.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)\/?$/);
    if (!match) continue;

    let candidateId: string;
    try {
      candidateId = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (PAYOUT_BATCH_ID_PATTERN.test(candidateId)) {
      return candidateId;
    }
  }

  return null;
}

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
   * Payout P3-B: GET /v1/payments/payouts/{payoutBatchId} — a single,
   * non-retrying read of a payout batch's latest known state. TRANSPORT
   * ONLY: makes no DB call, and never decides financial completion from
   * `batch_status` (including a `batch_status` of "SUCCESS") — only
   * ITEM-level `transaction_status` is ever meaningful for that, and even
   * that decision belongs to a future P3-C, not to this method. 404, any
   * other 4xx, 5xx, timeout, network failure, and a malformed/missing
   * `payout_batch_id` in an otherwise-2xx body are ALL classified UNKNOWN —
   * none of them is ever interpreted as payout failure or success.
   *
   * Shares the SAME bounded (15s), isolated OAuth acquisition and its own
   * independent 15s request timeout as createPayout() — see
   * getAccessTokenForPayout()'s own comment; getAccessToken() (the shared
   * deposit/order path) remains completely untouched.
   *
   * payoutBatchId is validated against PAYOUT_BATCH_ID_PATTERN before any
   * HTTP call (preventing path injection/traversal) and additionally
   * percent-encoded when embedded in the URL, matching this file's existing
   * getOrder()/captureOrder() precedent.
   */
  public async getPayoutBatch(payoutBatchId: string): Promise<PaypalGetPayoutBatchOutcome> {
    this.assertConfigured();
    if (!payoutBatchId || !PAYOUT_BATCH_ID_PATTERN.test(payoutBatchId)) {
      throw new Error('getPayoutBatch: payoutBatchId is invalid');
    }

    let accessToken: string;
    try {
      accessToken = await this.getAccessTokenForPayout();
    } catch (error: any) {
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
        response = await fetch(`${this.getBaseUrl()}/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          return { outcome: 'UNKNOWN', reason: `انتهت مهلة الاستعلام عن حالة التحويل من PayPal (${PAYOUT_CREATE_TIMEOUT_MS / 1000} ثانية)` };
        }
        return { outcome: 'UNKNOWN', reason: 'تعذر الاتصال ببوابة PayPal للاستعلام عن حالة التحويل' };
      }

      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null; // unparseable body — handled by the shape check below, never assumed to mean anything.
      }

      if (!response.ok) {
        // 404/4xx/5xx — never interpreted as payout failure or success.
        return { outcome: 'UNKNOWN', reason: `استجابة غير ناجحة من PayPal عند الاستعلام عن حالة التحويل (${response.status})` };
      }

      const responseBatchId = data?.batch_header?.payout_batch_id;
      if (typeof responseBatchId !== 'string' || !responseBatchId) {
        // 2xx but missing the one field everything else anchors to —
        // malformed, conservatively UNKNOWN.
        return { outcome: 'UNKNOWN', reason: 'استجابة ناجحة من PayPal دون هوية دفعة تحويل صالحة' };
      }
      if (responseBatchId !== payoutBatchId) {
        // Post-review hardening (identifier-consistency): the batch id
        // PayPal's response actually describes does not match the id we
        // explicitly requested. A response this inconsistent must never be
        // treated as a clean, trustworthy answer for the batch we asked
        // about — conservatively UNKNOWN rather than silently returned as
        // if it were the batch the caller queried for.
        return { outcome: 'UNKNOWN', reason: 'استجابة PayPal لا تطابق هوية دفعة التحويل المطلوبة' };
      }

      const rawBatchStatus = data?.batch_header?.batch_status;
      const batchStatus = typeof rawBatchStatus === 'string' && rawBatchStatus.trim() ? rawBatchStatus.trim().toUpperCase() : undefined;
      // Post-review field-shape audit: this project's confirmed official
      // PayPal contract (see the P3-B task's own "OFFICIAL PAYPAL CONTRACT
      // CONFIRMED" list) documents payout_batch_id/batch_status under
      // batch_header, and payout_item_id/payout_batch_id/transaction_status
      // as flat ITEM-level fields — it does NOT document
      // batch_header.sender_batch_header being echoed back on a GET
      // response at all. That prior nested read was pure speculation with
      // zero documented support (not even pattern-consistent with any
      // sibling confirmed field), so it has been removed rather than kept
      // as a guess. senderBatchId is intentionally always undefined until a
      // real, Sandbox-observed response confirms where (or whether) PayPal
      // actually echoes it back on this endpoint — conservative undefined
      // is preferable to speculative parsing.
      const senderBatchId: string | undefined = undefined;

      const rawItems = Array.isArray(data?.items) ? data.items : [];
      const items: PaypalPayoutItemResult[] = [];
      for (const item of rawItems) {
        const itemBatchIdRaw = item?.payout_batch_id;
        if (typeof itemBatchIdRaw === 'string' && itemBatchIdRaw && itemBatchIdRaw !== responseBatchId) {
          // Post-review hardening (identifier-consistency): an item whose
          // OWN payout_batch_id contradicts the batch-level id must never be
          // silently normalized into the batch's id — that would make a
          // genuinely inconsistent PayPal response look like a clean,
          // trustworthy reconciliation result. The whole response is
          // conservatively UNKNOWN instead.
          return { outcome: 'UNKNOWN', reason: 'تناقض في هوية دفعة التحويل بين مستوى الدفعة والعنصر' };
        }

        const rawStatus = item?.transaction_status;
        const normalizedStatus = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : undefined;
        // Post-review field-shape audit: the confirmed official contract
        // does not document a nested `payout_item` sub-object on a GET
        // response item at all — that prior nested-first guess
        // (payout_item.sender_item_id) had zero documented support and has
        // been removed. Only a single, flat `sender_item_id` read remains,
        // kept ONLY because it is at least pattern-consistent with the
        // OTHER confirmed item-level fields (payout_item_id/payout_batch_id/
        // transaction_status, all flat per the official contract) — still
        // explicitly unverified against a real captured response, and
        // marked here as a Sandbox characterization item, not a fact.
        const senderItemId = typeof item?.sender_item_id === 'string' ? item.sender_item_id : undefined;

        // Every item is preserved regardless of whether its status is
        // recognized — an unknown/missing transactionStatus must never
        // cause the item's other trusted identifiers (payoutItemId/
        // senderItemId) to be dropped; P3-C may still need them for
        // investigation/correlation.
        items.push({
          payoutItemId: typeof item?.payout_item_id === 'string' ? item.payout_item_id : undefined,
          payoutBatchId: responseBatchId,
          senderItemId,
          // ONLY a documented, recognized value — never guessed into any
          // financial state when missing/unrecognized.
          transactionStatus: normalizedStatus && KNOWN_ITEM_TRANSACTION_STATUSES.has(normalizedStatus) ? normalizedStatus : undefined
        });
      }

      return {
        outcome: 'FOUND',
        batch: { payoutBatchId: responseBatchId, batchStatus, senderBatchId, items }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Payout P3-B recovery transport: performs the ONE idempotent
   * re-submission PayPal's own documented contract explicitly supports —
   * re-POSTing /v1/payments/payouts with the EXACT SAME sender_batch_id,
   * sender_item_id, receiver, amount, and USD as the original attempt.
   * Intended ONLY for the specific case where a PayoutAttempt is PENDING,
   * its senderBatchId already exists, but payoutBatchId was never
   * persisted (the accepted-then-local-DB-failure scenario P2-C's own
   * review already analyzed) — never for a fresh, never-attempted payout
   * (that is createPayout()'s job).
   *
   * Idempotency/trust boundary: every field is reused VERBATIM from the
   * caller's params — this method never generates, derives, or falls back
   * to a replacement id of any kind, and performs exactly ONE HTTP attempt
   * (no internal retry loop; PayPal's own documented same-sender_batch_id
   * safety is what makes even a FUTURE, separate re-invocation of this same
   * method safe — this method itself does not loop).
   *
   * 30-DAY WINDOW: PayPal's idempotency guarantee for a given
   * sender_batch_id is documented as bounded to roughly the last 30 days.
   * This method has NO trusted timestamp context of its own (its params
   * are exactly senderBatchId/senderItemId/recipientEmail/amount, per this
   * task's own explicit scope) and therefore CANNOT enforce that window
   * itself. The future P3-C caller MUST gate any call to this method using
   * the durable PayoutAttempt.createdAt (or another already-trusted
   * timestamp) before invoking it — this method must never be assumed
   * safe to call unconditionally, no matter how old the original attempt.
   *
   * Duplicate-response handling: see
   * extractOriginalPayoutBatchIdFromDuplicateResponse()'s own extensive
   * comment. A non-2xx response is NEVER classified as a recoverable
   * duplicate merely because of its status code, error `name`, or any
   * free-text field — recovery only ever succeeds via a structurally safe,
   * origin-and-path-validated HATEOAS link. No DEFINITELY_FAILED outcome
   * exists here: this method returns UNKNOWN whenever it cannot prove
   * recovery, never a definite failure classification.
   *
   * SEMANTIC BOUNDARY (see PaypalRecoverPayoutResult's own doc comment for
   * the full statement): a RECOVERED result means IDENTITY ONLY — it is
   * never evidence of success, completion, or any specific item status.
   * The caller must still call getPayoutBatch() afterward.
   */
  public async recoverPayoutBySenderBatch(params: RecoverPayoutBySenderBatchParams): Promise<PaypalRecoverPayoutResult> {
    this.assertConfigured();

    assertNonEmpty(params.senderBatchId, 'senderBatchId');
    assertNonEmpty(params.senderItemId, 'senderItemId');
    if (!params.recipientEmail || !SIMPLE_EMAIL_PATTERN.test(params.recipientEmail.trim())) {
      throw new Error('recoverPayoutBySenderBatch: recipientEmail is invalid');
    }
    const normalizedAmount = normalizePayoutAmount(params.amount);

    let accessToken: string;
    try {
      accessToken = await this.getAccessTokenForPayout();
    } catch (error: any) {
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
        // Timeout and any other transport-level failure — both UNKNOWN, no
        // automatic second attempt from within this method.
        if (error?.name === 'AbortError') {
          return { outcome: 'UNKNOWN', reason: `انتهت مهلة إعادة محاولة الاسترجاع من PayPal (${PAYOUT_CREATE_TIMEOUT_MS / 1000} ثانية)` };
        }
        return { outcome: 'UNKNOWN', reason: 'تعذر الاتصال ببوابة PayPal لمحاولة الاسترجاع' };
      }

      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (response.ok) {
        // A 2xx here means PayPal treated this as (or equivalently to) a
        // fresh acceptance — structurally identical to createPayout()'s own
        // ACCEPTED shape check.
        const payoutBatchId = data?.batch_header?.payout_batch_id;
        if (typeof payoutBatchId === 'string' && payoutBatchId) {
          return { outcome: 'RECOVERED', payoutBatchId };
        }
        return { outcome: 'UNKNOWN', reason: 'استجابة ناجحة من PayPal دون هوية دفعة تحويل صالحة' };
      }

      // 5xx (or any other unexpected non-4xx status) — unconditionally
      // UNKNOWN, per this method's own explicit scope: a duplicate-batch
      // identification is only ever plausible on a 4xx client-error
      // response (PayPal rejecting the request as a duplicate), never on a
      // server error. No link-extraction attempt is made here at all —
      // even a coincidentally present `links` array on a 5xx is not trusted.
      if (!(response.status >= 400 && response.status < 500)) {
        return { outcome: 'UNKNOWN', reason: `خطأ من خادم PayPal أثناء محاولة الاسترجاع (${response.status})` };
      }

      // 4xx: the ONLY status range that may ever produce RECOVERED — and
      // only via a narrow, structurally-safe HATEOAS link extraction. Never
      // based on status code, error name, message, or details[].issue alone.
      const recoveredBatchId = extractOriginalPayoutBatchIdFromDuplicateResponse(data, this.getBaseUrl());
      if (recoveredBatchId) {
        return { outcome: 'RECOVERED', payoutBatchId: recoveredBatchId };
      }
      return { outcome: 'UNKNOWN', reason: `استجابة 4xx من PayPal دون رابط أصلي موثوق لاسترجاع هوية التحويل (${response.status})` };
    } finally {
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
