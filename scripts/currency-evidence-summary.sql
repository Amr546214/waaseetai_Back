-- READ-ONLY, AGGREGATE-ONLY evidence summary for the team to run on the target database with the access it ALREADY has (never production from this repo, never a write).
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -f scripts/currency-evidence-summary.sql > currency-evidence-result.txt
-- The whole script runs in a READ ONLY transaction with a statement timeout; it prints counts and sums only (no ids, emails or names), so the result can be shared as-is.
-- It runs BEFORE the phase-A migration too (it never references a column the migration adds).
-- NOTE: running this on an EMPTY database proves only that the SQL executes. It says nothing about dev's data.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

\echo '== S0 currency labels per table'
SELECT 'wallet_transactions' AS tbl, currency, COUNT(*) AS n FROM wallet_transactions GROUP BY currency
UNION ALL SELECT 'withdrawals', currency, COUNT(*) FROM withdrawals GROUP BY currency
UNION ALL SELECT 'commission_logs', currency, COUNT(*) FROM commission_logs GROUP BY currency
UNION ALL SELECT 'paypal_payments', currency, COUNT(*) FROM paypal_payments GROUP BY currency ORDER BY 1, 2;

\echo '== S1 (B) ledger rows produced by the SAR rail (Moyasar): real SAR amounts'
SELECT COUNT(*) AS rows, COUNT(DISTINCT "userId") AS accounts, MIN("createdAt")::date AS first_day, MAX("createdAt")::date AS last_day, status, currency, SUM(amount) AS amount_sum
FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%' GROUP BY status, currency;

\echo '== S2 (B) accounts that used the SAR rail: how many, and how much legacy balance they hold now (aggregate)'
SELECT COUNT(*) AS accounts, COALESCE(SUM(u."walletBalance"), 0) AS legacy_balance_sum
FROM users u WHERE EXISTS (SELECT 1 FROM wallet_transactions w WHERE w."userId" = u.id AND w."paymentMethod" ILIKE 'MOYASAR%' AND w.status = 'COMPLETED');

\echo '== S3 (B) money records of those accounts created before the USD-only cut-over (2026-09-28): the only ones USD cannot be proven for'
SELECT 'contracts' AS tbl, COUNT(*) AS n FROM contracts c WHERE c."createdAt" < '2026-09-28' AND c."clientId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%')
UNION ALL SELECT 'escrows', COUNT(*) FROM escrows e JOIN contracts c ON c."projectId" = e."projectId" WHERE e."createdAt" < '2026-09-28' AND c."clientId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%')
UNION ALL SELECT 'orders', COUNT(*) FROM orders o WHERE o."createdAt" < '2026-09-28' AND o."userId" IN (SELECT "userId" FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%');

\echo '== S4 (A) SAR label on a ledger row that NO SAR rail produced = a stale default label'
SELECT w.type, COALESCE(w."paymentMethod", '(none)') AS method, date_trunc('month', w."createdAt")::date AS period, COUNT(*) AS n, SUM(w.amount) AS amount_sum
FROM wallet_transactions w WHERE w.currency <> 'USD' AND COALESCE(w."paymentMethod", '') NOT ILIKE 'MOYASAR%' GROUP BY 1, 2, 3 ORDER BY 3, 1;

\echo '== S5 (A) withdrawals labelled other than USD, by method and status, with how many have a payout attempt (the payout itself is the evidence of the real currency)'
SELECT wd.method, wd.status, wd.currency AS label, COUNT(*) AS n, SUM(wd.amount) AS amount_sum, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa."withdrawalId" = wd.id)) AS with_payout_attempt
FROM withdrawals wd WHERE wd.currency <> 'USD' GROUP BY 1, 2, 3 ORDER BY 1, 2;

\echo '== S6 (A) commissions labelled other than USD vs the currency of the escrow they came from'
SELECT cl.currency AS commission_label, COALESCE(to_jsonb(e)->>'currency', CASE WHEN e.id IS NULL THEN '(no escrow)' ELSE '(escrow has no currency column yet)' END) AS source_escrow_currency, COUNT(*) AS n, SUM(cl.amount) AS amount_sum
FROM commission_logs cl LEFT JOIN escrows e ON e."projectId" = cl."sourceProjectId" WHERE cl.currency <> 'USD' GROUP BY 1, 2;

\echo '== S7 gateway requests (PayPal): non-USD requests, and ledger rows whose currency differs from the request'
SELECT COUNT(*) FILTER (WHERE p.currency <> 'USD') AS non_usd_requests, COUNT(*) FILTER (WHERE w.id IS NOT NULL AND w.currency <> p.currency) AS ledger_currency_mismatch
FROM paypal_payments p LEFT JOIN wallet_transactions w ON w."referenceId" = p."paypalCaptureId";

\echo '== S8 balance vs ledger (USD only): accounts whose legacy balance differs from the sum of their USD ledger rows by more than 0.01'
SELECT COUNT(*) AS accounts_out_of_balance FROM users u
WHERE ABS(u."walletBalance" - COALESCE((SELECT SUM(w.amount) FROM wallet_transactions w WHERE w."userId" = u.id AND w.status = 'COMPLETED' AND w.currency = 'USD'), 0)) > 0.01;
ROLLBACK;
