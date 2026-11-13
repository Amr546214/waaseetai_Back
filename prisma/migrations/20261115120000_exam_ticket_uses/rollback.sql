-- Never discard replay protection for a ticket that could still be accepted.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "exam_ticket_uses" WHERE "expiresAt" > CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'Cannot remove ticket replay protection while consumed tickets remain valid';
  END IF;
END $$;
DROP TABLE "exam_ticket_uses";
