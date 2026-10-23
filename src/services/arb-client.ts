import { ArbConfig } from '../config/arb.config';
import { decryptTrandata, encryptTrandata } from '../utils/arb-crypto';

/**
 * Wire layer to the ARB / Neoleap gateway (Al Rajhi REST guide v1.32). No database, no business rules.
 *  - Bank Hosted "Payment Token Generation": guide p.17-20 (request), p.26-27 (initial response, framing the payment URL)
 *  - Inquiry (action 8): guide p.129-137 (request p.130-132, response p.134-137)
 *  - mandatory X-FORWARDED-FOR customer IP header: p.13
 * TLS verification is never relaxed here. Every URL we call or send a user to must be https and on the configured allow-list.
 */

export interface ArbHttpResponse { status: number; text: string }
export interface ArbHttp { post(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<ArbHttpResponse> }

export const fetchArbHttp: ArbHttp = {
	async post(url, body, headers, timeoutMs) {
		const res = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
		return { status: res.status, text: await res.text() };
	},
};

export type CreateResult =
	| { kind: 'OK'; paymentId: string; pageUrl: string }
	| { kind: 'REJECTED'; code: string | null }
	| { kind: 'UNKNOWN' };

export interface BankTxn {
	paymentId: string | null;
	transId: string | null;
	trackId: string | null;
	result: string | null;
	amt: string | null;
	actionCode: string | null;
	ref: string | null;
	authCode: string | null;
	cardType: string | null;
	udf1: string | null;
	udf2: string | null;
	udf3: string | null;
}

export type InquiryResult =
	| { kind: 'TXN'; txn: BankTxn }
	| { kind: 'BANK_ERROR'; code: string | null; text: string | null }
	| { kind: 'UNKNOWN' };

const first = (v: unknown): any => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

export function isAllowedBankUrl(url: string, cfg: Pick<ArbConfig, 'allowedHosts'>): URL | null {
	try {
		const u = new URL(url);
		if (u.protocol !== 'https:' || u.username || u.password) return null;
		return cfg.allowedHosts.includes(u.hostname.toLowerCase()) ? u : null;
	} catch {
		return null;
	}
}

/**
 * JSON.parse that keeps long integers exact. The gateway sometimes sends ids as JSON NUMBERS (guide p.182-190: paymentId 18-19 digits, transId, trackId); a JS number
 * silently rounds anything above 2^53, which would turn an id into a different id. Integers of 16+ digits that stand as values (not inside a string) are read as strings.
 */
export function parseBankJson(text: string): any {
	return JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|(-?\b\d{16,}\b)(?![.\deE])/g, (m, quoted, big) => (quoted ? quoted : `"${big}"`)));
}

function parseJson(text: string): any | null {
	try { return first(parseBankJson(text)); } catch { return null; }
}

export function normalizeTxn(plain: any): BankTxn {
	return {
		paymentId: str(plain?.paymentId ?? plain?.paymentid),
		transId: str(plain?.transId ?? plain?.tranid),
		trackId: str(plain?.trackId),
		result: str(plain?.result),
		amt: str(plain?.amt),
		actionCode: str(plain?.actionCode),
		ref: str(plain?.ref),
		authCode: str(plain?.authCode),
		cardType: str(plain?.cardType),
		udf1: str(plain?.udf1),
		udf2: str(plain?.udf2),
		udf3: str(plain?.udf3),
	};
}

export interface CreateParams { amountSar: string; trackId: string; responseUrl: string; errorUrl: string; customerIp: string; udf1: string; udf2: string; udf3: string }

/** Bank Hosted: ask the gateway for a Payment ID + page URL. Anything unclear is UNKNOWN (the bank may have created it), never a failure. */
export async function createHostedPayment(cfg: ArbConfig, http: ArbHttp, p: CreateParams): Promise<CreateResult> {
	if (!isAllowedBankUrl(cfg.hostedTokenUrl, cfg)) return { kind: 'REJECTED', code: 'ENDPOINT_NOT_ALLOWED' };
	const plain = JSON.stringify([{
		amt: p.amountSar, action: '1', password: cfg.tranportalPassword, id: cfg.tranportalId, currencyCode: cfg.currencyCode,
		trackId: p.trackId, responseURL: p.responseUrl, errorURL: p.errorUrl, udf1: p.udf1, udf2: p.udf2, udf3: p.udf3, langid: 'ar',
	}]);
	const body = JSON.stringify([{ id: cfg.tranportalId, trandata: encryptTrandata(plain, cfg.resourceKey), responseURL: p.responseUrl, errorURL: p.errorUrl }]);
	let res: ArbHttpResponse;
	try {
		res = await http.post(cfg.hostedTokenUrl, body, { 'Content-Type': 'application/json', 'X-FORWARDED-FOR': p.customerIp }, cfg.httpTimeoutMs);
	} catch {
		return { kind: 'UNKNOWN' };
	}
	const j = parseJson(res.text);
	if (res.status !== 200 || !j) return { kind: 'UNKNOWN' };
	if (String(j.status) === '2') return { kind: 'REJECTED', code: str(j.error) };
	if (String(j.status) !== '1' || typeof j.result !== 'string') return { kind: 'UNKNOWN' };
	// "paymentId:https://host/pg/paymentpage.htm" — split on the FIRST colon only (the URL contains one)
	const i = j.result.indexOf(':');
	const paymentId = i > 0 ? j.result.slice(0, i) : '';
	const url = isAllowedBankUrl(i > 0 ? j.result.slice(i + 1) : '', cfg);
	if (!/^\d{10,25}$/.test(paymentId) || !url) return { kind: 'REJECTED', code: 'DESTINATION_NOT_ALLOWED' };
	return { kind: 'OK', paymentId, pageUrl: `${url.origin}${url.pathname}?PaymentID=${paymentId}` };
}

export type InquiryBy = { by: 'TrackID'; trackId: string } | { by: 'TRANID'; transId: string } | { by: 'PaymentID'; paymentId: string };

/** Supporting transaction action 8 (Inquiry). Returns the decrypted bank record, a bank error, or UNKNOWN (network / unreadable). */
export async function inquire(cfg: ArbConfig, http: ArbHttp, by: InquiryBy, amountSar: string, trackId: string): Promise<InquiryResult> {
	if (!isAllowedBankUrl(cfg.inquiryUrl, cfg)) return { kind: 'UNKNOWN' };
	const transId = by.by === 'TrackID' ? by.trackId : by.by === 'TRANID' ? by.transId : by.paymentId;
	const plain = JSON.stringify([{ amt: amountSar, action: '8', password: cfg.tranportalPassword, id: cfg.tranportalId, currencyCode: cfg.currencyCode, trackId, udf5: by.by, transId }]);
	const body = JSON.stringify([{ id: cfg.tranportalId, trandata: encryptTrandata(plain, cfg.resourceKey) }]);
	let res: ArbHttpResponse;
	try {
		res = await http.post(cfg.inquiryUrl, body, { 'Content-Type': 'application/json' }, cfg.httpTimeoutMs);
	} catch {
		return { kind: 'UNKNOWN' };
	}
	const j = parseJson(res.text);
	if (res.status !== 200 || !j) return { kind: 'UNKNOWN' };
	if (!j.trandata) return String(j.status) === '2' || j.error ? { kind: 'BANK_ERROR', code: str(j.error), text: str(j.errorText) } : { kind: 'UNKNOWN' };
	try {
		const txn = normalizeTxn(first(parseBankJson(decryptTrandata(String(j.trandata), cfg.resourceKey))));
		return { kind: 'TXN', txn };
	} catch {
		return { kind: 'UNKNOWN' };
	}
}

/** Decrypts the browser-return / notification `trandata`. null = unreadable (treat as untrusted, never as a result). */
export function readReturnTrandata(cfg: ArbConfig, trandata: unknown): BankTxn | null {
	if (typeof trandata !== 'string' || !trandata) return null;
	try { return normalizeTxn(first(parseBankJson(decryptTrandata(trandata, cfg.resourceKey)))); } catch { return null; }
}
