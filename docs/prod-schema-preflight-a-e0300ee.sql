-- ============================================================================
-- NOT EXECUTED.  READ-ONLY preflight for PART A (additive schema changes).
-- Run it right before part A:
--   psql -v ON_ERROR_STOP=1 -f prod-schema-preflight-a-e0300ee.sql
-- Any failed check RAISEs an exception (psql exits non-zero).  No writes.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN READ ONLY;

DO $$
DECLARE
  n bigint;
  missing text;
BEGIN
  -- 1. PostgreSQL >= 12 (ALTER TYPE ... ADD VALUE inside a transaction)
  IF current_setting('server_version_num')::int < 120000 THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: PostgreSQL % is older than 12', current_setting('server_version');
  END IF;

  -- 2. commission_logs must be EMPTY: part A adds NOT NULL columns without defaults
  IF to_regclass('public.commission_logs') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: table commission_logs does not exist';
  END IF;
  SELECT count(*) INTO n FROM public.commission_logs;
  IF n <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: commission_logs has % rows (adding NOT NULL columns without a default would fail)', n;
  END IF;

  -- 3. Objects part A will create must NOT exist yet (guards against a half-applied earlier attempt)
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY[
    'special_offers','special_offer_redemptions','notification_preferences','support_tickets',
    'support_ticket_messages','project_amendments','payout_attempts','paypal_webhook_events',
    'paypal_payments','company_team_members']) AS t WHERE to_regclass('public.'||t) IS NOT NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT FAIL: tables already exist: %', missing; END IF;

  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY[
    'ApprovalStatus','SpecialOfferType','SupportTicketStatus','AmendmentRequesterRole','AmendmentType',
    'AmendmentStatus','PayoutAttemptStatus','PaypalWebhookEventStatus','PaypalPaymentStatus',
    'TeamMemberType','TeamMemberStatus']) AS t WHERE EXISTS (SELECT 1 FROM pg_type WHERE typname = t);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT FAIL: enum types already exist: %', missing; END IF;

  SELECT string_agg(c, ', ') INTO missing FROM (VALUES
    ('users','marketingMonthlySpendCap'),('users','phoneOtpEnabled'),('projects','assignedEmployeeId'),
    ('provider_profiles','paypalPayoutEmail'),('withdrawals','paypalEmail'),('affiliate_profiles','level'),
    ('coupons','approvalStatus'),('coupons','assignedToTeamMemberId'),('coupons','createdByTeamMemberId'),
    ('coupons','excludedServiceIds'),('coupons','internalNote'),('coupons','rejectionReason'),
    ('commission_logs','appliedPercentage'),('commission_logs','baseAmount'),('commission_logs','level'),
    ('commission_logs','referredUserId'),('commission_logs','sourceProjectId'),('commission_logs','sourceStageId')
  ) AS v(tbl, col)
  CROSS JOIN LATERAL (SELECT tbl||'.'||col AS c) x
  WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=v.tbl AND column_name=v.col);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT FAIL: columns already exist: %', missing; END IF;

  SELECT string_agg(v, ', ') INTO missing FROM (VALUES ('CommissionType','STAGE_RELEASE'),('WithdrawalStatus','PROCESSING'),('WithdrawalStatus','REVERSED')) AS e(typ, v)
  WHERE EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid WHERE ty.typname = e.typ AND en.enumlabel = e.v);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT FAIL: enum values already exist: %', missing; END IF;

  -- 4. Objects part A depends on must exist (foreign-key targets and altered tables)
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY[
    'users','projects','contracts','orders','service_catalogs','withdrawals','coupons','affiliate_profiles',
    'provider_profiles','commission_logs']) AS t WHERE to_regclass('public.'||t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT FAIL: required tables missing: %', missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname IN ('CommissionType')) OR NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WithdrawalStatus') THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: enum types CommissionType/WithdrawalStatus missing';
  END IF;

  -- 5. No transaction left idle-in-transaction for > 5 minutes (it could hold locks that block the DDL)
  SELECT count(*) INTO n FROM pg_stat_activity WHERE state = 'idle in transaction' AND xact_start < now() - interval '5 minutes';
  IF n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT FAIL: % long idle-in-transaction sessions', n; END IF;

  RAISE NOTICE 'PREFLIGHT A OK (server %, commission_logs empty, no target objects exist)', current_setting('server_version');
END
$$;

ROLLBACK;
