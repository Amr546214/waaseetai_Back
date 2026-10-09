-- ============================================================================
-- NOT EXECUTED. Local draft only (decision 2026-10-06: all money is USD; Moyasar and every SAR link are removed; PayPal is the only deposit rail).
-- Never run from the dev Mac: the team applies it on the server after review. No FX rate was ever approved,
-- so the conversion statements below are TEMPLATES with a placeholder rate and must not be run as-is.
-- ============================================================================

-- ── A) READ-ONLY inventory (safe SELECTs) ────────────────────────────────────────────────────────
-- A1. wallet transactions by currency / type / method
SELECT currency, type, "paymentMethod", status, COUNT(*) AS n, SUM(amount) AS total
FROM wallet_transactions GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;

-- A2. users whose balance may include SAR credits (a SAR deposit incremented walletBalance in the same column as USD)
SELECT u.id, u."walletBalance",
       SUM(CASE WHEN t.currency = 'SAR' AND t.type = 'DEPOSIT'  AND t.status = 'COMPLETED' THEN t.amount ELSE 0 END) AS sar_deposits,
       SUM(CASE WHEN t.currency = 'USD' AND t.type = 'DEPOSIT'  AND t.status = 'COMPLETED' THEN t.amount ELSE 0 END) AS usd_deposits
FROM users u JOIN wallet_transactions t ON t."userId" = u.id
GROUP BY u.id, u."walletBalance"
HAVING SUM(CASE WHEN t.currency = 'SAR' AND t.type = 'DEPOSIT' AND t.status = 'COMPLETED' THEN t.amount ELSE 0 END) > 0;

-- A3. withdrawals and commission logs by currency
SELECT currency, status, COUNT(*), SUM(amount) FROM withdrawals GROUP BY 1,2;
SELECT currency, status, COUNT(*), SUM(amount) FROM commission_logs GROUP BY 1,2;

-- A3b. historical rows that came from removed rails (kept as history; the app no longer creates them)
SELECT "paymentMethod", currency, status, COUNT(*), SUM(amount) FROM wallet_transactions
WHERE "paymentMethod" ILIKE 'MOYASAR%' OR "paymentMethod" = 'BANK_TRANSFER' GROUP BY 1,2,3;

-- A4. any other table that carries a currency column
SELECT table_name, column_name, column_default
FROM information_schema.columns
WHERE column_name ILIKE '%currency%' AND table_schema = 'public' ORDER BY 1;

-- ── B) CORRECTION TEMPLATES (NOT APPROVED — require an owner-approved FX rate) ───────────────────
-- :fx = SAR→USD rate approved by the owner (e.g. 0.2667). Run each block in its own transaction, after a pg_dump.
-- B1. relabel+convert SAR wallet transactions (keeps an audit trail of the original in metadata)
-- BEGIN;
-- UPDATE wallet_transactions
--    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('originalCurrency', 'SAR', 'originalAmount', amount, 'fx', :fx),
--        amount   = ROUND((amount * :fx)::numeric, 2),
--        currency = 'USD'
--  WHERE currency = 'SAR';
-- -- B2. users.walletBalance: ONLY for users whose balance still contains the SAR deposits found in A2, converted by their own SAR share
-- -- (never a blanket UPDATE: USD credits from PayPal / escrow releases are already USD)
-- -- UPDATE users SET "walletBalance" = "walletBalance" - sar_deposits + ROUND(sar_deposits * :fx, 2) WHERE id IN (...A2...);
-- UPDATE withdrawals    SET currency = 'USD', amount = ROUND((amount * :fx)::numeric, 2) WHERE currency = 'SAR' AND status IN ('PENDING','APPROVED','PROCESSING');
-- UPDATE commission_logs SET currency = 'USD', amount = ROUND((amount * :fx)::numeric, 2), "baseAmount" = ROUND(("baseAmount" * :fx)::numeric, 2) WHERE currency = 'SAR';
-- COMMIT;

-- ── C) Schema defaults (needs the team: schema.prisma edit + migration, NOT done here) ───────────
-- ALTER TABLE wallet_transactions ALTER COLUMN currency SET DEFAULT 'USD';
-- ALTER TABLE withdrawals         ALTER COLUMN currency SET DEFAULT 'USD';
-- ALTER TABLE commission_logs     ALTER COLUMN currency SET DEFAULT 'USD';
-- (schema.prisma lines ~1788, 2241, 2567 plus the "Phase 7" SAR comment at ~127)
