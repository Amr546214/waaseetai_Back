-- ROLLBACK for 20261106100000_identity_field_checks. NOT EXECUTED anywhere. Drops only what the migration created (data in the table is advisory and re-creatable).
DROP TABLE IF EXISTS "identity_field_checks";
DROP TYPE IF EXISTS "IdentityFieldCheckStatus";
DROP TYPE IF EXISTS "IdentityCheckParty";
