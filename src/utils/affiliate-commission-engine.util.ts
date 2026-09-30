// Release gate for the P-LG-012 affiliate commission engine
// (src/services/affiliate-commission.service.ts, wired into
// project-progress.service.ts::reviewDelivery()'s escrow-release points).
//
// ============================================================================
// CURRENCY GATE — this flag stays OFF (default/unset) until a human
// explicitly resolves the USD-vs-SAR policy question below. Do not flip it
// to 'true' as part of implementing this feature.
// ============================================================================
//
// The real qualifying trigger for a commission — a stage escrow release in
// reviewDelivery()'s approve path — is denominated in USD (confirmed by the
// existing `currency: 'USD'` field already written into that same
// transaction's accountAuditLog metadata, and by "دولار" in the underlying
// Arabic product text). CommissionLog.currency, however, defaults to "SAR"
// in the Prisma schema, and P-LG-012's own withdrawal-minimum figure (300)
// is stated in "ريال" (SAR).
//
// Computing `level% x USD-base-amount` and then recording/paying that result
// AS SAR would require an FX conversion that has NOT been approved by
// anyone and must NOT be invented here. Until that policy question is
// explicitly resolved (fix the exchange rate? keep commissions in USD and
// pay affiliates in USD? something else?), this flag keeps the entire
// commission-creation hook a complete no-op in production: zero side
// effects, zero writes, identical behavior to today.
//
// When (and only when) this is explicitly enabled, commissions are computed
// and stored in USD — the REAL transaction currency — never SAR. See
// affiliate-commission.service.ts's createCommissionsForStageReleaseEvent(),
// which sets `currency: 'USD'` explicitly on every row it writes rather than
// relying on the schema's SAR default.
//
// Same on/off convention as this codebase's other feature flags (e.g.
// PAYOUT_AUTOMATION_ENABLED in payout-automation.util.ts, SMS_ENABLED in
// notification.service.ts): unset, or anything other than the literal
// string 'true', means disabled — fail closed by default.
export function isAffiliateCommissionEngineEnabled(): boolean {
  return process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED === 'true';
}
