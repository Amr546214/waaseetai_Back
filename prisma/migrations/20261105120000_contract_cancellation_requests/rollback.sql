-- Rollback (only while the table holds no data worth keeping). NOT EXECUTED.
DROP TABLE IF EXISTS "contract_cancellation_requests";
DROP TYPE IF EXISTS "CancellationSettlementStatus";
DROP TYPE IF EXISTS "CancellationRequestStatus";
