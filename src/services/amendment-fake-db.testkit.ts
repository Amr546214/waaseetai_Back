// TEST KIT ONLY (never imported by production code): a small in-memory stand-in for the Prisma models the amendment flow touches.
// It is NOT a database: it implements the where-operators the code uses (equality, in, gte, not, increment/decrement), the unique keys that matter,
// and `$transaction` as SERIALIZED + ROLLBACK-ON-THROW (a mutex plus a snapshot), which is exactly the outcome a row lock + rollback gives. Tests built on it
// prove the logic and the invariants; they do not prove Postgres isolation behavior.

type Row = Record<string, any>;

const clone = <T>(v: T): T => structuredClone(v);

const matchValue = (actual: any, cond: any): boolean => {
	if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
		for (const [op, v] of Object.entries(cond)) {
			if (op === 'in') { if (!(v as any[]).includes(actual)) return false; }
			else if (op === 'gte') { if (!(actual >= (v as number))) return false; }
			else if (op === 'lt') { if (!(actual < (v as number))) return false; }
			else if (op === 'not') { if (actual === v) return false; }
			else return false;
		}
		return true;
	}
	return actual === cond || (actual == null && cond == null);
};
const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([k, v]) => k === 'OR' ? (v as Row[]).some(w => matches(row, w)) : matchValue(row[k], v));

const applyData = (row: Row, data: Row) => {
	for (const [k, v] of Object.entries(data)) {
		if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && ('increment' in v || 'decrement' in v)) {
			row[k] = (Number(row[k]) || 0) + (('increment' in v ? (v as any).increment : 0) - ('decrement' in v ? (v as any).decrement : 0));
		} else row[k] = v;
	}
};

export const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target: [target] } });

export function createFakeDb(initial: Record<string, Row[]> = {}) {
	// Runs inside the serialized transaction slot, right before its snapshot: lets a test simulate "something else committed first" (a stage approval, a dispute...).
	const hooks: { onTransactionStart?: (db: any) => Promise<void> | void } = {};
	const tables: Record<string, Row[]> = {
		user: [], contract: [], escrow: [], projectStage: [], projectAmendment: [], walletTransaction: [], otpVerification: [],
		contractTermsVersion: [], accountAuditLog: [], notification: [], conversation: [], dispute: [], projectProposal: [], stageDelivery: []
	};
	for (const [k, rows] of Object.entries(initial)) tables[k] = clone(rows);
	let idCounter = 0;
	const log: { model: string; op: string; args: any }[] = [];
	let tail: Promise<unknown> = Promise.resolve();

	const uniqueChecks: Record<string, (rows: Row[], candidate: Row, self?: Row) => void> = {
		walletTransaction: (rows, c, self) => { if (c.referenceId && rows.some(r => r !== self && r.referenceId === c.referenceId)) throw uniqueError('wallet_transactions_referenceId_key'); },
		projectStage: (rows, c, self) => { if (rows.some(r => r !== self && r.contractId === c.contractId && r.stepOrder === c.stepOrder)) throw uniqueError('project_stages_contractId_stepOrder_key'); },
		contractTermsVersion: (rows, c, self) => {
			if (rows.some(r => r !== self && r.amendmentId === c.amendmentId)) throw uniqueError('contract_terms_versions_amendmentId_key');
			if (rows.some(r => r !== self && r.contractId === c.contractId && r.version === c.version)) throw uniqueError('contract_terms_versions_contractId_version_key');
		}
	};

	const delegate = (model: string) => {
		const rows = () => tables[model];
		const record = (op: string, args: any) => log.push({ model, op, args: clone(args) });
		const out = (row: Row | undefined | null) => (row ? clone(row) : null);
		return {
			findFirst: async (args: any = {}) => { record('findFirst', args); return out(rows().find(r => matches(r, args.where))); },
			findUnique: async (args: any = {}) => { record('findUnique', args); return out(rows().find(r => matches(r, args.where))); },
			findMany: async (args: any = {}) => {
				record('findMany', args);
				let found = rows().filter(r => matches(r, args.where)).map(clone);
				const order = args.orderBy && !Array.isArray(args.orderBy) ? Object.entries(args.orderBy)[0] : null;
				if (order) found.sort((a, b) => ((a[order[0]] > b[order[0]] ? 1 : -1) * (order[1] === 'desc' ? -1 : 1)));
				if (args.take) found = found.slice(0, args.take);
				return found;
			},
			count: async (args: any = {}) => { record('count', args); return rows().filter(r => matches(r, args.where)).length; },
			create: async (args: any) => {
				record('create', args);
				const row: Row = { id: args.data.id ?? `${model}-${++idCounter}`, createdAt: new Date(), updatedAt: new Date(), ...(model === 'projectAmendment' && args.include ? { project: { title: 'مشروع' }, provider: { firstName: 'نورة', lastName: 'م' } } : {}), ...(model === 'projectStage' ? { deliveries: [] } : {}), ...clone(args.data) };
				uniqueChecks[model]?.(rows(), row);
				rows().push(row);
				return clone(row);
			},
			createMany: async (args: any) => { record('createMany', args); for (const d of args.data) { const row = { id: `${model}-${++idCounter}`, ...clone(d) }; uniqueChecks[model]?.(rows(), row); rows().push(row); } return { count: args.data.length }; },
			updateMany: async (args: any) => {
				record('updateMany', args);
				const hit = rows().filter(r => matches(r, args.where));
				for (const r of hit) {
					const next = clone(r);
					applyData(next, args.data);
					uniqueChecks[model]?.(rows(), next, r);
					Object.assign(r, next);
				}
				return { count: hit.length };
			},
			update: async (args: any) => {
				record('update', args);
				const r = rows().find(x => matches(x, args.where));
				if (!r) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
				applyData(r, args.data);
				return clone(r);
			},
			deleteMany: async (args: any = {}) => { record('deleteMany', args); const keep = rows().filter(r => !matches(r, args.where)); const n = rows().length - keep.length; tables[model] = keep; return { count: n }; },
			delete: async (args: any) => { record('delete', args); const i = rows().findIndex(r => matches(r, args.where)); if (i < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' }); return clone(rows().splice(i, 1)[0]); }
		};
	};

	const models = Object.fromEntries(Object.keys(tables).map(m => [m, delegate(m)])) as Record<string, ReturnType<typeof delegate>>;
	const snapshot = () => clone(tables);
	const restore = (snap: Record<string, Row[]>) => { for (const k of Object.keys(tables)) tables[k] = snap[k]; };

	const db: any = {
		...models,
		// Serialized + rollback on throw. `tx` is the same object (the fake has one shared state).
		$transaction: (fn: (tx: any) => Promise<any>) => {
			const run = async () => {
				await hooks.onTransactionStart?.(db);
				const snap = snapshot();
				try { return await fn(db); } catch (error) { restore(snap); throw error; }
			};
			const result = tail.then(run, run);
			tail = result.catch(() => undefined);
			return result;
		}
	};
	return { db, tables, log, hooks };
}

export type FakeWorld = ReturnType<typeof seedWorld>;

/** A realistic ACTIVE contract: 20 USD, two 10 USD stages (7 + 7 days), v2 escrow HELD at 12.75 %, a client wallet of 100 USD. */
export function seedWorld(over: { wallet?: number; escrow?: Row; contract?: Row; stages?: Row[]; amendments?: Row[]; disputes?: Row[]; otps?: Row[]; user?: Row } = {}) {
	const now = new Date();
	const contract = { id: 'contract-abcdef123', projectId: 'project-1', clientId: 'client-1', providerId: 'provider-1', status: 'ACTIVE', price: 20, durationDays: 14, phasesCount: 2, termsVersion: 1, signedAt: new Date(now.getTime() - 2 * 86400000), createdAt: now, updatedAt: now, ...over.contract };
	const escrow = { id: 'escrow-1', projectId: 'project-1', amount: 20, status: 'HELD', releasedAmount: 0, feePolicyVersion: 2, providerCommissionRateSnapshot: 12.75, providerCommissionLevelSnapshot: 1, platformCommissionAmount: 0, providerNetReleasedAmount: 0, ...over.escrow };
	const stages = over.stages ?? [
		{ id: 'stage-1', contractId: contract.id, stepOrder: 1, title: 'التصميم', description: null, days: 7, percentage: 50, amount: 10, status: 'IN_PROGRESS', amendmentId: null, deliveries: [] },
		{ id: 'stage-2', contractId: contract.id, stepOrder: 2, title: 'التنفيذ', description: null, days: 7, percentage: 50, amount: 10, status: 'PENDING', amendmentId: null, deliveries: [] }
	];
	const users = [
		{ id: 'client-1', email: 'client@example.com', walletBalance: over.wallet ?? 100, ...over.user },
		{ id: 'provider-1', email: 'provider@example.com', walletBalance: 0 }
	];
	const fake = createFakeDb({
		user: users, contract: [contract], escrow: [escrow], projectStage: stages as Row[],
		projectAmendment: (over.amendments ?? []).map(a => amendmentRow(a)), dispute: over.disputes ?? [], otpVerification: over.otps ?? [],
		conversation: [{ id: 'conv-1', projectId: 'project-1', providerId: 'provider-1' }]
	});
	return { ...fake, contract, escrow };
}

export function amendmentRow(o: Row = {}): Row {
	return {
		id: 'amend-1', projectId: 'project-1', contractId: 'contract-abcdef123', clientId: 'client-1', providerId: 'provider-1', requestedById: 'provider-1', requestedByRole: 'PROVIDER',
		type: 'BUDGET', title: 'زيادة الميزانية', description: null, budgetDelta: 5, durationDeltaDays: null, status: 'PENDING_OTHER_PARTY',
		createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'), respondedAt: null,
		appliedAt: null, priceBefore: null, priceAfter: null, durationBefore: null, durationAfter: null, addedStageId: null, fundingAuthorizedAt: null, fundingAuthorizedAmount: null, fundingAuthorizedTerms: null,
		project: { title: 'مشروع' }, provider: { firstName: 'نورة', lastName: 'م' }, ...o
	};
}

/** termsFingerprint of the seeded contract (termsVersion 1, price 20, 14 days). */
export const DEFAULT_TERMS = '1|20|14';
export const otpRow = (o: Row = {}): Row => ({
	id: 'otp-1', userId: 'client-1', code: '123456', type: 'EMAIL', attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 120000),
	context: { purpose: 'AMENDMENT_PAYMENT', amendmentId: 'amend-1', amount: 5, terms: DEFAULT_TERMS }, ...o
});
