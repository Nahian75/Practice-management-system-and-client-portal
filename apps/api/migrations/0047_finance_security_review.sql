-- Review F1: a finance action must hold the account and role rows that make
-- its actor eligible. Otherwise a concurrent role revocation or account
-- disable can commit while the action continues on an earlier observation.
CREATE OR REPLACE FUNCTION app.assert_active_accounts(actor_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles r ON r.account_id = a.id
  WHERE a.id = actor_id
    AND a.kind = 'staff'
    AND a.status = 'active'
    AND r.role = 'accounts'
    AND r.revoked_at IS NULL
  FOR SHARE OF a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing changes require active Accounts staff'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.assert_active_compliance(actor_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles r ON r.account_id = a.id
  WHERE a.id = actor_id
    AND a.kind = 'staff'
    AND a.status = 'active'
    AND r.role = 'compliance'
    AND r.revoked_at IS NULL
  FOR SHARE OF a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an active compliance role is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Review F2: recording the bank outcome before the four-eyes approval date
-- would make the ledger say that an authorised withdrawal happened before
-- the authority existed. The ordinary validation trigger runs first, locks
-- the request and proves that its current state is approved. This second
-- trigger then compares the immutable approval event with the bank date.
CREATE FUNCTION app.require_payment_date_after_approval() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  approval_date date;
BEGIN
  IF NEW.kind <> 'paid' THEN
    RETURN NEW;
  END IF;

  SELECT (e.acted_at AT TIME ZONE 'Europe/London')::date
  INTO approval_date
  FROM app.client_payment_events e
  WHERE e.payment_request_id = NEW.payment_request_id
    AND e.kind = 'approved'
  ORDER BY e.id DESC
  LIMIT 1;

  IF approval_date IS NULL OR NEW.occurred_on < approval_date THEN
    RAISE EXCEPTION 'the paid date cannot be before approval'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.require_payment_date_after_approval() FROM PUBLIC;

-- Trigger names at one timing run alphabetically. The existing "validate"
-- trigger first establishes and locks the valid state; this suffix runs next.
CREATE TRIGGER client_payment_events_validate_paid_date
  BEFORE INSERT ON app.client_payment_events
  FOR EACH ROW EXECUTE FUNCTION app.require_payment_date_after_approval();

-- Review F3: Rule 8 requires the firm to retain the list behind its aggregate
-- client liabilities, not only the total. Capture every non-zero matter
-- balance with the reconciliation so later backdated postings cannot rewrite
-- what Compliance signed.
CREATE TABLE app.client_account_reconciliation_balances (
  id                uuid   PRIMARY KEY DEFAULT uuidv7(),
  reconciliation_id uuid   NOT NULL REFERENCES app.client_account_reconciliations(id),
  client_id          uuid   NOT NULL REFERENCES app.clients(id),
  matter_id          uuid   NOT NULL REFERENCES app.matters(id),
  balance_pence      bigint NOT NULL,

  CONSTRAINT client_account_reconciliation_balances_positive CHECK (balance_pence > 0),
  CONSTRAINT client_account_reconciliation_balances_matter_unique UNIQUE (reconciliation_id, matter_id)
);

CREATE INDEX client_account_reconciliation_balances_reconciliation_idx
  ON app.client_account_reconciliation_balances (reconciliation_id, id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON app.client_account_reconciliation_balances FROM pms_app;

CREATE FUNCTION app.snapshot_client_ledger_balances() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  snapshot_total numeric;
BEGIN
  INSERT INTO app.client_account_reconciliation_balances (
    reconciliation_id, client_id, matter_id, balance_pence
  )
  SELECT NEW.id, p.client_id, p.matter_id,
    sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END)
  FROM app.finance_postings p
  JOIN app.finance_transactions t ON t.id = p.transaction_id
  WHERE p.account = 'client_ledger' AND t.occurred_on <= NEW.as_of
  GROUP BY p.client_id, p.matter_id
  HAVING sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END) > 0;

  SELECT coalesce(sum(balance_pence), 0) INTO snapshot_total
  FROM app.client_account_reconciliation_balances
  WHERE reconciliation_id = NEW.id;
  IF snapshot_total <> NEW.client_ledger_balance_pence THEN
    RAISE EXCEPTION 'the client ledger balance list does not match its total'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.snapshot_client_ledger_balances() FROM PUBLIC;

CREATE FUNCTION app.require_reconciliation_balance_total() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  expected numeric;
  actual numeric;
BEGIN
  SELECT client_ledger_balance_pence INTO expected
  FROM app.client_account_reconciliations WHERE id = NEW.reconciliation_id;
  SELECT coalesce(sum(balance_pence), 0) INTO actual
  FROM app.client_account_reconciliation_balances
  WHERE reconciliation_id = NEW.reconciliation_id;
  IF actual <> expected THEN
    RAISE EXCEPTION 'the client ledger balance list does not match its total'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.require_reconciliation_balance_total() FROM PUBLIC;

CREATE TRIGGER client_account_reconciliations_snapshot_balances
  AFTER INSERT ON app.client_account_reconciliations
  FOR EACH ROW EXECUTE FUNCTION app.snapshot_client_ledger_balances();

CREATE CONSTRAINT TRIGGER client_account_reconciliation_balances_total
  AFTER INSERT ON app.client_account_reconciliation_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.require_reconciliation_balance_total();

CREATE TRIGGER client_account_reconciliation_balances_fixed
  BEFORE UPDATE OR DELETE ON app.client_account_reconciliation_balances
  FOR EACH ROW EXECUTE FUNCTION app.refuse_reconciliation_edit();
CREATE TRIGGER client_account_reconciliation_balances_no_truncate
  BEFORE TRUNCATE ON app.client_account_reconciliation_balances
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_reconciliation_edit();

-- The project is still pre-production, but keep upgrade behaviour complete for
-- any local records made before this review.
INSERT INTO app.client_account_reconciliation_balances (
  reconciliation_id, client_id, matter_id, balance_pence
)
WITH matter_balances AS (
  SELECT r.id AS reconciliation_id, r.client_ledger_balance_pence AS expected,
    p.client_id, p.matter_id,
    sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END) AS balance_pence
  FROM app.client_account_reconciliations r
  JOIN app.finance_transactions t ON t.occurred_on <= r.as_of
  JOIN app.finance_postings p ON p.transaction_id = t.id AND p.account = 'client_ledger'
  GROUP BY r.id, r.client_ledger_balance_pence, p.client_id, p.matter_id
), complete AS (
  SELECT matter_balances.*,
    sum(balance_pence) OVER (PARTITION BY reconciliation_id) AS reconstructed_total
  FROM matter_balances WHERE balance_pence > 0
)
SELECT reconciliation_id, client_id, matter_id, balance_pence
FROM complete WHERE reconstructed_total = expected;
