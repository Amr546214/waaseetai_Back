# NOT EXECUTED — schema changes for the USD-only decision (2026-10-06)

Local draft only. `prisma/schema.prisma` was NOT edited and no prisma command was run. The team applies this on the server.

## schema.prisma edits (proposed)
| Line | Now | Proposed |
|---|---|---|
| ~127 | `// Phase 7 — company-wide monthly cap (SAR) on total marketing discounts` | `(USD)` |
| ~1788 (CommissionLog) | `currency String @default("SAR")` | `@default("USD")` |
| ~2241 (Withdrawal) | `currency String @default("SAR")` | `@default("USD")` |
| ~2567 (WalletTransaction) | `currency String @default("SAR")` | `@default("USD")` |
| ~2569-2570 | comments naming `MOYASAR_CARD`, `MOYASAR_APPLEPAY`, `BANK_TRANSFER`, "Moyasar payment id" | `'PAYPAL', 'WALLET'` / "PayPal capture id"; the stored historical values stay readable |
| ~2580 | `(separate gateway from Moyasar)` | remove the phrase |

```diff
-  currency String           @default("SAR")
+  currency String           @default("USD")
```

## SQL (after the schema edit, applied by the team; existing rows are NOT rewritten by a default change)
```sql
ALTER TABLE commission_logs     ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE withdrawals         ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE wallet_transactions ALTER COLUMN currency SET DEFAULT 'USD';
```
Historical rows keep whatever currency/payment-method value they were stored with (see docs/local-sar-cleanup-NOT-EXECUTED.sql for the inventory and the disabled correction templates).
