export interface MoyasarPaymentResponse {
  id: string;
  status: 'initiated' | 'paid' | 'failed' | 'authorized' | 'captured' | 'refunded' | 'voided';
  amount: number; // In Halalas (SAR * 100)
  fee: number;
  currency: string;
  refunded: number;
  refunded_at: string | null;
  captured: number;
  captured_at: string | null;
  description: string | null;
  amount_format: string;
  fee_format: string;
  ip: string | null;
  callback_url: string | null;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
  source: {
    type: string; // 'creditcard' | 'applepay' | 'stcpay'
    company?: string; // 'visa' | 'master' | 'mada'
    name?: string;
    number?: string;
    gateway_id?: string;
    reference_number?: string;
    message?: string;
    transaction_url?: string;
  };
}

export class MoyasarService {
  private secretKey: string;
  private publishableKey: string;
  private baseUrl = 'https://api.moyasar.com/v1';

  constructor() {
    this.secretKey = process.env.MOYASAR_SECRET_KEY || '';
    this.publishableKey = process.env.MOYASAR_PUBLISHABLE_KEY || '';
  }

  public getPublishableKey(): string {
    if (!this.publishableKey) {
      throw new Error('بوابة ميسر غير مهيأة: MOYASAR_PUBLISHABLE_KEY غير معرّف');
    }
    return this.publishableKey;
  }

  /**
   * Fetches and verifies a payment record from Moyasar API by payment ID
   */
  public async fetchPayment(paymentId: string): Promise<MoyasarPaymentResponse> {
    if (!this.secretKey) {
      throw new Error('بوابة ميسر غير مهيأة: MOYASAR_SECRET_KEY غير معرّف');
    }

    try {
      const authHeader = `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`;
      const response = await fetch(`${this.baseUrl}/payments/${paymentId}`, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Moyasar API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as MoyasarPaymentResponse;
      return data;
    } catch (error: any) {
      console.warn('[MoyasarService] fetchPayment error:', error.message);
      throw new Error(error.response?.data?.message || 'تعذر التحقق من عملية الدفع من بوابة ميسر');
    }
  }

  /**
   * Validates if a payment is paid and matches the requested deposit amount
   */
  public async verifyDeposit(paymentId: string, expectedAmountSar?: number): Promise<{
    valid: boolean;
    payment?: MoyasarPaymentResponse;
    reason?: string;
  }> {
    if (!paymentId) {
      return { valid: false, reason: 'معرّف عملية الدفع غير صالح' };
    }

    try {
      const payment = await this.fetchPayment(paymentId);

      if (payment.status !== 'paid' && payment.status !== 'captured') {
        return {
          valid: false,
          payment,
          reason: `حالة الدفع غير مكتملة (${payment.status || 'فشلت العملية'})`
        };
      }

      // Convert expected SAR to Halalas (1 SAR = 100 Halalas)
      const expectedHalalas = expectedAmountSar === undefined ? undefined : Math.round(expectedAmountSar * 100);
      if (expectedHalalas !== undefined && payment.amount !== expectedHalalas) {
        return {
          valid: false,
          payment,
          reason: `مبلغ الدفع (${payment.amount / 100} ريال) لا يطابق المبلغ المطلوب (${expectedAmountSar} ريال)`
        };
      }

      if (payment.currency !== 'SAR') {
        return { valid: false, payment, reason: 'عملة عملية الدفع لا تطابق الريال السعودي' };
      }

      return { valid: true, payment };
    } catch (err: any) {
      return { valid: false, reason: err.message || 'فشل الاتصال ببوابة ميسر' };
    }
  }
}

export const moyasarService = new MoyasarService();
