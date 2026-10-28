import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Proof that the person registering controls the typed e-mail address, BEFORE any account exists. Nothing is stored in the database:
 *  - the ticket is a signed token {email, nonce, exp} that the browser keeps and sends back;
 *  - the 6-digit code is derived from the server secret and the ticket's nonce, so it cannot be computed from the ticket.
 * Neither can sign anyone in or activate an account: they only authorise creating the account for THIS address (the key is separate from
 * the session JWT key and the token carries its own purpose, so it is rejected everywhere else).
 */
export const REGISTER_PROOF_VALIDITY_MS = 10 * 60 * 1000;
export const REGISTER_PROOF_MAX_WRONG_CODES = 5;
/** A proven address may try other data (e.g. a corrected phone) a few times with the same code; then a new code is required. */
export const REGISTER_PROOF_MAX_REJECTED_COMPLETIONS = 3;
const PURPOSE = 'REGISTER_EMAIL_PROOF';

const secret = (): string => {
	const s = process.env.JWT_SECRET;
	if (!s) throw new Error('JWT_SECRET is not configured');
	return s;
};
const key = (label: string): Buffer => crypto.createHmac('sha256', secret()).update(`waseet:${label}`).digest();

const codeFor = (email: string, nonce: string): string => {
	const n = crypto.createHmac('sha256', key('register-proof-code')).update(`${nonce}|${email}`).digest().readUInt32BE(0) % 1_000_000;
	return String(n).padStart(6, '0');
};

export function issueRegistrationProof(email: string, now: number = Date.now()): { ticket: string; code: string; expiresAt: Date } {
	const nonce = crypto.randomBytes(16).toString('hex');
	const expiresAt = new Date(now + REGISTER_PROOF_VALIDITY_MS);
	const ticket = jwt.sign({ purpose: PURPOSE, email, nonce }, key('register-proof-ticket'), { algorithm: 'HS256', expiresIn: Math.floor(REGISTER_PROOF_VALIDITY_MS / 1000) });
	return { ticket, code: codeFor(email, nonce), expiresAt };
}

export type ProofCheck = { ok: true; nonce: string } | { ok: false };

/** Signature, purpose, expiry, address and code all have to match; every failure is the same `{ ok: false }`. */
export function checkRegistrationProof(ticket: string, email: string, code: string): ProofCheck {
	try {
		const claims = jwt.verify(ticket, key('register-proof-ticket'), { algorithms: ['HS256'] }) as { purpose?: string; email?: string; nonce?: string };
		if (claims.purpose !== PURPOSE || !claims.nonce || claims.email !== email) return { ok: false };
		const expected = Buffer.from(codeFor(email, claims.nonce));
		const given = Buffer.from(code);
		if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false };
		return { ok: true, nonce: claims.nonce };
	} catch {
		return { ok: false };
	}
}

/** Per-ticket attempt counters (in memory, like the OTP send throttle: single process; a restart only resets them). */
export class ProofAttempts {
	private readonly wrong = new Map<string, { n: number; until: number }>();
	private readonly rejected = new Map<string, { n: number; until: number }>();
	constructor(private readonly maxKeys = 20_000) {}

	private bump(m: Map<string, { n: number; until: number }>, nonce: string, now: number): number {
		if (m.size >= this.maxKeys) for (const [k, v] of m) { if (v.until <= now) m.delete(k); }
		if (m.size >= this.maxKeys) m.clear();
		const cur = m.get(nonce);
		const n = (cur && cur.until > now ? cur.n : 0) + 1;
		m.set(nonce, { n, until: now + REGISTER_PROOF_VALIDITY_MS });
		return n;
	}
	private count(m: Map<string, { n: number; until: number }>, nonce: string, now: number): number {
		const cur = m.get(nonce);
		return cur && cur.until > now ? cur.n : 0;
	}
	/** The nonce of a ticket is only known once its signature is valid; a wrong code is counted against the ticket's own nonce. */
	isLocked(nonce: string, now: number = Date.now()): boolean {
		return this.count(this.wrong, nonce, now) >= REGISTER_PROOF_MAX_WRONG_CODES || this.count(this.rejected, nonce, now) >= REGISTER_PROOF_MAX_REJECTED_COMPLETIONS;
	}
	recordWrongCode(nonce: string, now: number = Date.now()): void { this.bump(this.wrong, nonce, now); }
	recordRejectedCompletion(nonce: string, now: number = Date.now()): void { this.bump(this.rejected, nonce, now); }
	reset(): void { this.wrong.clear(); this.rejected.clear(); }
}
export const proofAttempts = new ProofAttempts();

/** A ticket whose code was wrong cannot be counted by nonce until its signature is read: this reads the nonce of a signed (even wrong-code) ticket. */
export function nonceOfTicket(ticket: string, email: string): string | null {
	try {
		const c = jwt.verify(ticket, key('register-proof-ticket'), { algorithms: ['HS256'] }) as { purpose?: string; email?: string; nonce?: string };
		return c.purpose === PURPOSE && c.email === email && c.nonce ? c.nonce : null;
	} catch { return null; }
}
