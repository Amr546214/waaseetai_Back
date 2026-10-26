BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
-- ROW-LEVEL detail (contains user and record ids: for the team's own review, NOT to be pasted into a ticket; use currency-evidence-summary.sql for anything shared). Runs before or after the phase-A migration.
-- READ-ONLY. Evidence per AMBIGUOUS group of old money rows. Run on dev with the existing read permission; NEVER run on production from here, never modify anything.
-- Two different problems, kept apart on purpose:
--   (A) a WRONG DEFAULT LABEL: the column said 'SAR' because nobody set it (wallet_transactions / withdrawals / commission_logs defaulted to 'SAR' until 2026-10); the AMOUNT came from a USD flow.
--   (B) a REAL AMOUNT IN ANOTHER CURRENCY that entered the wallet: Moyasar (SAR-only) credited users.walletBalance with a SAR amount from 2026-08-31 until it was disabled on 2026-09-28.
-- Relabelling fixes (A) only; it does not repair (B), which is an accounting question (the legacy USD balance of such an account mixes currencies) and needs a decision, never a rate invented here.

-- G0. the overall picture: labels per table
SELECT 'wallet_transactions' t, currency, COUNT(*) n, MIN("createdAt") first_at, MAX("createdAt") last_at FROM wallet_transactions GROUP BY currency
UNION ALL SELECT 'withdrawals', currency, COUNT(*), MIN("createdAt"), MAX("createdAt") FROM withdrawals GROUP BY currency
UNION ALL SELECT 'commission_logs', currency, COUNT(*), MIN("createdAt"), MAX("createdAt") FROM commission_logs GROUP BY currency
UNION ALL SELECT 'paypal_payments', currency, COUNT(*), MIN("createdAt"), MAX("createdAt") FROM paypal_payments GROUP BY currency ORDER BY 1, 2;

-- G1 (B). deposits made through the SAR rail: gateway request -> amount and currency collected -> ledger row -> effect on the balance
--   referenceId is the Moyasar payment id (no local gateway-request table exists for Moyasar; this ledger row IS the only record of the collection).
SELECT w.id ledger_id, w."userId", w."createdAt", w.type, w.status, w."paymentMethod", w.currency AS ledger_currency, w.amount AS ledger_amount, w."referenceId" AS gateway_payment_id,
       u."walletBalance" AS legacy_balance_now
FROM wallet_transactions w JOIN users u ON u.id = w."userId"
WHERE w."paymentMethod" ILIKE 'MOYASAR%' ORDER BY w."createdAt";

-- G1b. what those accounts did with their balance afterwards (money that left the wallet after a SAR credit may have spent SAR-origin funds)
SELECT w."userId", w.type, w.currency, COUNT(*) n, SUM(w.amount) total
FROM wallet_transactions w
WHERE w."userId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%')
GROUP BY w."userId", w.type, w.currency ORDER BY w."userId", w.type;

-- G1c. escrows / contracts funded by those accounts (cannot be proven pure USD from their own data)
SELECT e.id escrow_id, e."projectId", e.amount, to_jsonb(e)->>'currency' AS escrow_currency, e."fundedAt", c.id contract_id, c.price, to_jsonb(c)->>'currency' AS contract_currency, c."clientId"
FROM escrows e JOIN contracts c ON c."projectId" = e."projectId"
WHERE c."clientId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%') ORDER BY e."fundedAt";

-- G2 (A). SAR label on a ledger row that NO SAR rail produced: the stale default. Show what produced it (type / method / period)
SELECT w.type, w."paymentMethod", date_trunc('month', w."createdAt") AS period, COUNT(*) n, SUM(w.amount) total
FROM wallet_transactions w WHERE w.currency <> 'USD' AND COALESCE(w."paymentMethod", '') NOT ILIKE 'MOYASAR%'
GROUP BY 1, 2, 3 ORDER BY 3, 1;

-- G3 (A). withdrawals labelled SAR: the payout itself is the evidence of the real currency (PayPal paid in USD). attempt rows show what was actually sent
SELECT wd.id withdrawal_id, wd."userId", wd.method, wd.currency AS withdrawal_label, wd.amount, wd.status, wd."createdAt",
       (SELECT COUNT(*) FROM payout_attempts pa WHERE pa."withdrawalId" = wd.id) payout_attempts,
       (SELECT string_agg(pa.status::text, ',') FROM payout_attempts pa WHERE pa."withdrawalId" = wd.id) attempt_statuses,
       (SELECT string_agg(DISTINCT t.currency, ',') FROM wallet_transactions t WHERE t."referenceId" = wd."referenceId") ledger_currency_of_the_debit
FROM withdrawals wd WHERE wd.currency <> 'USD' ORDER BY wd."createdAt";

-- G4 (A). commissions labelled SAR: the base amount came from a released stage; the escrow's currency is the source of truth
SELECT cl.id commission_id, cl."affiliateId", cl.currency AS commission_label, cl.amount, cl."baseAmount", cl.status, cl."sourceProjectId",
       to_jsonb(e)->>'currency' AS source_escrow_currency, e."feePolicyVersion", cl."createdAt"
FROM commission_logs cl LEFT JOIN escrows e ON e."projectId" = cl."sourceProjectId" WHERE cl.currency <> 'USD' ORDER BY cl."createdAt";

-- G5. gateway requests (PayPal): currency and amount collected vs what the wallet got (a mismatch would show here)
SELECT p.id payment_id, p."userId", p.currency AS paypal_currency, p.amount AS charged, p."netAmount" AS credited_net, p."feeAmount", p.status, w.currency AS ledger_currency, w.amount AS ledger_amount
FROM paypal_payments p LEFT JOIN wallet_transactions w ON w."referenceId" = p."paypalCaptureId" WHERE p.currency <> 'USD' OR (w.id IS NOT NULL AND w.currency <> p.currency) ORDER BY p."createdAt";

-- G6. the twelve phase-A columns default to USD: which records pre-date the USD-only cut-over (2026-09-28) AND belong to an account that used the SAR rail? Those are the only ones USD cannot be proven for.
SELECT 'contracts' t, COUNT(*) n FROM contracts c WHERE c."createdAt" < '2026-09-28' AND c."clientId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%')
UNION ALL SELECT 'escrows', COUNT(*) FROM escrows e JOIN contracts c ON c."projectId" = e."projectId" WHERE e."createdAt" < '2026-09-28' AND c."clientId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%')
UNION ALL SELECT 'orders', COUNT(*) FROM orders o WHERE o."createdAt" < '2026-09-28' AND o."userId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%');

ROLLBACK;
