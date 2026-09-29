// Release gate for Payout P3-D (automated PayPal payouts). Deliberately
// separate from the PayPal DEPOSIT path (paypal.service.ts / paypal-finance
// .service.ts / Add Funds) — this flag never touches deposit behavior.
//
// P3-D's own tables (payout_attempts, paypal_webhook_events) have no
// migration in this release (see DRIVE_REVIEW_PLAN.md, FINAL RELEASE
// INTEGRATION AUDIT). Calling into payoutService.sendPayout() or
// payoutWebhookService.processPayoutWebhookEvent() against a database
// that hasn't run that migration would throw a raw "table does not exist"
// error. Every P3-D entry point checks this flag FIRST and returns an
// honest, typed response instead of reaching that code — the P3-D
// implementation itself is untouched and reactivates by setting this to
// 'true' once its migration has been applied.
//
// Same on/off convention as this codebase's other feature flags (e.g.
// notification.service.ts's SMS_ENABLED): unset or anything other than the
// literal string 'true' means disabled — fail closed by default.
export function isPayoutAutomationEnabled(): boolean {
  return process.env.PAYOUT_AUTOMATION_ENABLED === 'true';
}
