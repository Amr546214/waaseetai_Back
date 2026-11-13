/**
 * TEST DOUBLE — NOT THE REAL AI SERVICE. Never imported by production code.
 * Stands in for POST {AI_BASE}/v1/ai/identity/compare-fields as described in the ID-compare brief (the owner's real implementation, branch
 * feat/identity-field-ocr @ 9acee92, is not available). A "synthetic card image" here is just bytes of a JSON document
 * {"name","dob","id","unreadable":[fields]} that the double "reads" in place of a model; its CODE then compares like the contract says.
 * A passing test with this double proves PLUMBING ONLY (trigger, persistence, idempotency, authorisation, redaction). It is NOT evidence that
 * real card reading works, and no accuracy claim may be made from it.
 */
import { WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';
import type { IdentityCompareFieldsRequest, IdentityCompareFieldsResponse, IdentityFieldName, IdentityFieldResult } from '../services/ai/waseet-ai/waseet-ai.types';

export interface SyntheticCard { name: string; dob: string; id: string; unreadable?: IdentityFieldName[] }
export const syntheticImage = (card: SyntheticCard): Buffer => Buffer.from(JSON.stringify(card), 'utf8');

export type DoubleMode = 'ok' | 'down' | 'timeout' | 'garbage' | 'slow';
export class IdentityCompareTestDouble {
	calls: IdentityCompareFieldsRequest[] = [];
	mode: DoubleMode = 'ok';
	delayMs = 0;
	configured = true;
	isConfigured() { return this.configured; }
	async compareIdentityFields(body: IdentityCompareFieldsRequest): Promise<IdentityCompareFieldsResponse> {
		this.calls.push(body);
		if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
		if (this.mode === 'down') { throw new WaseetAiError(WaseetAiErrorCode.PROVIDER_UNAVAILABLE, 'down'); }
		if (this.mode === 'timeout') { throw new WaseetAiError(WaseetAiErrorCode.TIMEOUT, 'timeout'); }
		if (this.mode === 'garbage') return { nonsense: true } as any;
		const card: SyntheticCard = JSON.parse(Buffer.from(body.image, 'base64').toString('utf8'));
		const cmp = (name: IdentityFieldName, read: string, reg: string): IdentityFieldResult =>
			card.unreadable?.includes(name) ? { status: 'COULD_NOT_VERIFY', reason: 'FIELD_NOT_VISIBLE' } : read === reg ? { status: 'MATCH' } : { status: 'MISMATCH' };
		return {
			requestId: body.requestId,
			fields: {
				fullName: cmp('fullName', card.name, body.registered.fullName),
				birthDate: cmp('birthDate', card.dob, body.registered.birthDate),
				nationalId: cmp('nationalId', card.id, body.registered.nationalId)
			},
			model: { name: 'TEST-DOUBLE-NOT-A-MODEL', version: '0' },
			readAt: new Date().toISOString()
		};
	}
}
