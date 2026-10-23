import { ArbConfig } from '../config/arb.config';
import { ArbHttp } from './arb-client';
import { decryptTrandata, encryptTrandata } from '../utils/arb-crypto';

/**
 * SIMULATED bank for tests only — NOT the real gateway. It speaks the wire format of guide v1.32 (encrypted trandata, [{...}] arrays, the initial
 * "paymentId:url" answer, Inquiry action 8) so the application code is exercised end to end, and it can misbehave on demand
 * (lost answer, delay, wrong amount, different ids, authorization only ...). Anything proven only with this object is "simulated", never "real".
 */
export const TEST_KEY = 'TESTKEY0123456789ABCDEFGHIJKLMNO';
export const TEST_HOST = 'sim-bank.test';

export const testConfig = (over: Partial<ArbConfig> = {}): ArbConfig => ({
	enabled: true, tranportalId: 'TESTTRANPORTALID', tranportalPassword: 'test-password', resourceKey: TEST_KEY,
	hostedTokenUrl: `https://${TEST_HOST}/pg/payment/hosted.htm`, inquiryUrl: `https://${TEST_HOST}/pg/payment/tranportal.htm`,
	allowedHosts: [TEST_HOST], publicBaseUrl: 'https://app.test', sarPerUsd: 3.75 /* TEST FIXTURE ONLY — the real rate is an owner decision */, feePercent: 2.5 /* TEST FIXTURE ONLY — no fee is approved */, allowedUserIds: ['ALL'],
	currencyCode: '682', httpTimeoutMs: 1000, attemptTtlMin: 30, ...over,
});

export interface SimTxn {
	paymentId: string; trackId: string; amt: string; currency: string; udf1: string; udf2: string; udf3: string; action: string;
	result: string | null; transId: string | null; amtOverride?: string; udf1Override?: string; trackOverride?: string; paymentOverride?: string; actionOverride?: string;
}

export class SimBank implements ArbHttp {
	txns: SimTxn[] = [];
	creates = 0;
	inquiries = 0;
	log: { url: string; headers: Record<string, string>; plain: any }[] = [];
	// behaviours
	delayCreateMs = 0;
	dropCreateAnswer = false; // processed at the bank, answer lost on the way back
	rejectCreate: string | null = null;
	badDestination: string | null = null;
	failInquiry: 'none' | 'timeout' | 'garbage' | 'notfound' | 'expired' = 'none';
	private seq = 7_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
	constructor(private key = TEST_KEY) {}

	async post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
		const req = JSON.parse(body)[0];
		const plain = JSON.parse(decryptTrandata(req.trandata, this.key))[0];
		this.log.push({ url, headers, plain });
		if (plain.action === '1') return this.create(req, plain);
		if (plain.action === '8') return this.inquiry(plain);
		return { status: 200, text: JSON.stringify([{ status: '2', error: 'IPAY0100020', errorText: 'Invalid Action type.', result: null }]) };
	}

	private async create(_req: any, plain: any) {
		this.creates++;
		if (this.delayCreateMs) await new Promise(r => setTimeout(r, this.delayCreateMs));
		if (this.rejectCreate) return { status: 200, text: JSON.stringify([{ status: '2', error: this.rejectCreate, errorText: 'Invalid Transaction Amount.', result: null }]) };
		const paymentId = String(++this.seq) + String(Math.floor(1000 + Math.random() * 8999));
		this.txns.push({ paymentId, trackId: plain.trackId, amt: plain.amt, currency: plain.currencyCode, udf1: plain.udf1, udf2: plain.udf2, udf3: plain.udf3, action: plain.action, result: null, transId: null });
		if (this.dropCreateAnswer) throw new Error('socket hang up');
		const dest = this.badDestination ?? `https://${TEST_HOST}/pg/paymentpage.htm`;
		return { status: 200, text: JSON.stringify([{ status: '1', result: `${paymentId}:${dest}`, error: null, errorText: null }]) };
	}

	private inquiry(plain: any) {
		this.inquiries++;
		if (this.failInquiry === 'timeout') throw new Error('timeout');
		if (this.failInquiry === 'expired') return { status: 200, text: JSON.stringify([{ status: '2', error: 'IPAY0100042', errorText: 'PaymentId Expired.', trandata: null }]) };
		if (this.failInquiry === 'garbage') return { status: 200, text: '<html>oops</html>' };
		const t = this.txns.find(x => (plain.udf5 === 'PaymentID' && x.paymentId === plain.transId) || (plain.udf5 === 'TrackID' && x.trackId === plain.transId) || (plain.udf5 === 'TRANID' && x.transId === plain.transId));
		if (this.failInquiry === 'notfound' || !t) return { status: 200, text: JSON.stringify([{ status: '2', error: 'IPAY0100054', errorText: 'Payment details not available.', trandata: null }]) };
		return { status: 200, text: JSON.stringify([{ status: '1', trandata: this.trandataFor(t), error: null, errorText: null }]) };
	}

	/** what the bank would put in `trandata` for this transaction (final response / notification / inquiry) */
	trandataFor(t: SimTxn): string {
		const rec: any = {
			paymentId: t.paymentOverride ?? t.paymentId, result: t.result ?? 'INITIALIZED', ref: t.transId ? '935110000001' : null, transId: t.transId, date: '1023', trackId: t.trackOverride ?? t.trackId,
			udf1: t.udf1Override ?? t.udf1, udf2: t.udf2, udf3: t.udf3, udf4: '', udf5: '', amt: t.amtOverride ?? t.amt, authRespCode: '00', authCode: '000000', cardType: 'Mada',
			actionCode: t.actionOverride ?? t.action, card: '506968XXXXXX1063', expMonth: '06', expYear: '2027',
		};
		return encryptTrandata(JSON.stringify([rec]), this.key);
	}

	/** the cardholder pays / is declined on the bank page */
	settle(paymentId: string, result: string, transId = String(++this.seq)) {
		const t = this.byPayment(paymentId);
		t.result = result;
		t.transId = transId;
		return t;
	}
	byPayment(paymentId: string) { const t = this.txns.find(x => x.paymentId === paymentId); if (!t) throw new Error('no such sim txn'); return t; }
	last() { return this.txns[this.txns.length - 1]; }
}
