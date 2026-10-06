// Release gate for the P-LG-012 affiliate commission engine
// (src/services/affiliate-commission.service.ts, wired into
// project-progress.service.ts::reviewDelivery()'s escrow-release points).
//
// Commissions are computed and stored in USD — the real transaction currency. affiliate-commission.service.ts's
// createCommissionsForStageReleaseEvent() sets `currency: 'USD'` explicitly on every row it writes.
//
// This flag stays OFF (default/unset) until a human explicitly enables the engine: unset, the entire commission-creation hook
// is a complete no-op in production (zero reads, zero writes, zero side effects).
//
// Same on/off convention as this codebase's other feature flags (e.g.
// PAYOUT_AUTOMATION_ENABLED in payout-automation.util.ts, SMS_ENABLED in
// notification.service.ts): unset, or anything other than the literal
// string 'true', means disabled — fail closed by default.
export function isAffiliateCommissionEngineEnabled(): boolean {
  return process.env.AFFILIATE_COMMISSION_ENGINE_ENABLED === 'true';
}
