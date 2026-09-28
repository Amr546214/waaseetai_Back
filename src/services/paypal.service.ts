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
