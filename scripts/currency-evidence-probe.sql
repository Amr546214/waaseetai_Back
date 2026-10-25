-- READ-ONLY evidence probe for "are the stored money rows really USD?". Run by the team on the target database BEFORE migration 20261027110000_money_currency_columns. Changes nothing.
-- Background (from git history): Moyasar (SAR-only) credited wallets from 2026-08-31 until it was disabled on 2026-09-28; USD/PayPal-only since. wallet_transactions, withdrawals and
-- commission_logs had a column DEFAULT 'SAR', so a row written without an explicit currency carries a 'SAR' LABEL even though its amount came from the USD-only flows.
-- A TRUE SAR amount = a ledger row created by a SAR rail (payment method MOYASAR_*). A default-label row = SAR label on a row that no SAR rail produced.

-- 1) every currency label per ledger table
SELECT 'wallet_transactions' AS tbl, currency, COUNT(*) FROM wallet_transactions GROUP BY currency
UNION ALL SELECT 'withdrawals', currency, COUNT(*) FROM withdrawals GROUP BY currency
UNION ALL SELECT 'commission_logs', currency, COUNT(*) FROM commission_logs GROUP BY currency
UNION ALL SELECT 'paypal_payments', currency, COUNT(*) FROM paypal_payments GROUP BY currency ORDER BY 1, 2;

-- 2) TRUE SAR evidence: rows produced by the SAR rail (must be 0 for "existing rows are USD" to hold)
SELECT 'moyasar rail rows' AS evidence, COUNT(*) AS n, MIN("createdAt") AS first_at, MAX("createdAt") AS last_at FROM wallet_transactions WHERE "paymentMethod" ILIKE 'MOYASAR%';
-- withdrawals have no SAR rail of their own (PayPal / bank / USDT); show label by method so a bank-transfer SAR label can be judged by a human
SELECT 'withdrawals by method and label' AS evidence, method, currency, COUNT(*) FROM withdrawals GROUP BY method, currency ORDER BY 2, 3;

-- 3) SAR label WITHOUT a SAR rail = default-label rows (the amount is USD-flow, the label is a stale default). These are NOT relabelled by the migration; a separate, approved correction handles them.
SELECT 'wallet_transactions SAR label, no SAR rail' AS evidence, COUNT(*) FROM wallet_transactions WHERE currency <> 'USD' AND COALESCE("paymentMethod", '') NOT ILIKE 'MOYASAR%';
SELECT 'withdrawals SAR label' AS evidence, COUNT(*) FROM withdrawals WHERE currency <> 'USD';
SELECT 'commission_logs SAR label' AS evidence, COUNT(*) FROM commission_logs WHERE currency <> 'USD';

-- 4) accounts whose LEGACY wallet balance may mix currencies: they received a Moyasar (SAR) deposit that was credited to users.walletBalance
SELECT u.id, u.email, u."walletBalance" FROM users u WHERE EXISTS (SELECT 1 FROM wallet_transactions w WHERE w."userId" = u.id AND w."paymentMethod" ILIKE 'MOYASAR%' AND w.status = 'COMPLETED') ORDER BY u."walletBalance" DESC;

-- 5) money records that predate the USD-only cut-over and were funded from such accounts (cannot be proven USD from their own data)
SELECT 'escrows funded by a SAR-rail account' AS evidence, COUNT(*) FROM escrows e JOIN contracts c ON c."projectId" = e."projectId"
WHERE EXISTS (SELECT 1 FROM wallet_transactions w WHERE w."userId" = c."clientId" AND w."paymentMethod" ILIKE 'MOYASAR%' AND w.status = 'COMPLETED');
