-- PREPARED, NOT EXECUTED, NEEDS OWNER APPROVAL. Corrects the stale-default 'SAR' LABEL on ledger rows that no SAR rail produced (amount is a USD-flow amount).
-- Run scripts/currency-evidence-probe.sql first; run this only when section 2 of the probe shows 0 rows from the SAR rail, or after the SAR-rail rows were handled separately.
-- Every change is recorded in currency_label_corrections (before value) so it can be reversed exactly. No amount is changed.
BEGIN;
CREATE TABLE IF NOT EXISTS currency_label_corrections (id bigserial PRIMARY KEY, tbl text NOT NULL, row_id text NOT NULL, before_currency text NOT NULL, after_currency text NOT NULL, corrected_at timestamptz NOT NULL DEFAULT now());
INSERT INTO currency_label_corrections (tbl, row_id, before_currency, after_currency) SELECT 'wallet_transactions', id, currency, 'USD' FROM wallet_transactions WHERE currency <> 'USD' AND COALESCE("paymentMethod", '') NOT ILIKE 'MOYASAR%';
UPDATE wallet_transactions SET currency = 'USD' WHERE currency <> 'USD' AND COALESCE("paymentMethod", '') NOT ILIKE 'MOYASAR%';
INSERT INTO currency_label_corrections (tbl, row_id, before_currency, after_currency) SELECT 'withdrawals', id, currency, 'USD' FROM withdrawals WHERE currency <> 'USD';
UPDATE withdrawals SET currency = 'USD' WHERE currency <> 'USD';
INSERT INTO currency_label_corrections (tbl, row_id, before_currency, after_currency) SELECT 'commission_logs', id, currency, 'USD' FROM commission_logs WHERE currency <> 'USD';
UPDATE commission_logs SET currency = 'USD' WHERE currency <> 'USD';
-- ROLLBACK of the correction: UPDATE <tbl> t SET currency = c.before_currency FROM currency_label_corrections c WHERE c.tbl = '<tbl>' AND c.row_id = t.id::text;
COMMIT;
