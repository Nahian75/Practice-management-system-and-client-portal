-- Step 17f: Matter fee estimates, budgets, and onboarding initial payments / deposit handoff

-- 1. Matter Fee Estimates and Budgets table
CREATE TABLE app.matter_fee_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id uuid NOT NULL REFERENCES app.matters(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES app.clients(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  charging_basis text NOT NULL CHECK (charging_basis IN ('fixed', 'hourly', 'contingency', 'capped', 'pro_bono')),
  estimated_fees_pence bigint NOT NULL CHECK (estimated_fees_pence >= 0),
  estimated_disbursements_pence bigint NOT NULL DEFAULT 0 CHECK (estimated_disbursements_pence >= 0),
  estimated_vat_pence bigint NOT NULL DEFAULT 0 CHECK (estimated_vat_pence >= 0),
  total_estimate_pence bigint NOT NULL CHECK (total_estimate_pence = estimated_fees_pence + estimated_disbursements_pence + estimated_vat_pence),
  budget_limit_pence bigint CHECK (budget_limit_pence IS NULL OR budget_limit_pence >= 0),
  currency text NOT NULL DEFAULT 'GBP',
  assumptions text NOT NULL CHECK (assumptions <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  agreed_with_client boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app.accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_matter_fee_estimate_version UNIQUE (matter_id, version)
);

CREATE INDEX idx_matter_fee_estimates_matter ON app.matter_fee_estimates (matter_id, version DESC);
CREATE INDEX idx_matter_fee_estimates_client ON app.matter_fee_estimates (client_id, created_at DESC);

-- Trigger to protect matter fee estimates immutability
CREATE OR REPLACE FUNCTION app.protect_matter_fee_estimates()
  RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'matter fee estimates cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'active' AND NEW.status = 'superseded' AND
       OLD.id = NEW.id AND
       OLD.matter_id = NEW.matter_id AND
       OLD.client_id = NEW.client_id AND
       OLD.version = NEW.version AND
       OLD.charging_basis = NEW.charging_basis AND
       OLD.estimated_fees_pence = NEW.estimated_fees_pence AND
       OLD.estimated_disbursements_pence = NEW.estimated_disbursements_pence AND
       OLD.estimated_vat_pence = NEW.estimated_vat_pence AND
       OLD.total_estimate_pence = NEW.total_estimate_pence AND
       ((OLD.budget_limit_pence IS NULL AND NEW.budget_limit_pence IS NULL) OR OLD.budget_limit_pence = NEW.budget_limit_pence) AND
       OLD.currency = NEW.currency AND
       OLD.assumptions = NEW.assumptions AND
       OLD.agreed_with_client = NEW.agreed_with_client AND
       OLD.created_by = NEW.created_by AND
       OLD.created_at = NEW.created_at THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'matter fee estimates are immutable once recorded' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_fee_estimates_protect
  BEFORE UPDATE OR DELETE ON app.matter_fee_estimates
  FOR EACH ROW EXECUTE FUNCTION app.protect_matter_fee_estimates();


-- 2. Onboarding Initial Payment Requests table
CREATE TABLE app.onboarding_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id) ON DELETE RESTRICT,
  matter_id uuid REFERENCES app.matters(id) ON DELETE RESTRICT,
  engagement_document_id uuid REFERENCES app.engagement_documents(id) ON DELETE SET NULL,
  reference text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('deposit_on_account', 'initial_fixed_fee', 'consultation')),
  description text NOT NULL CHECK (description <> ''),
  amount_pence bigint NOT NULL CHECK (amount_pence > 0),
  currency text NOT NULL DEFAULT 'GBP',
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'waived', 'cancelled')),
  payment_method text CHECK (payment_method IS NULL OR payment_method IN ('bank_transfer', 'card', 'portal_checkout', 'cheque', 'cash')),
  paid_at timestamptz,
  paid_reference text,
  bank_account_details jsonb,
  notes text,
  requested_by uuid NOT NULL REFERENCES app.accounts(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES app.accounts(id) ON DELETE RESTRICT,
  updated_at timestamptz
);

CREATE INDEX idx_onboarding_payment_requests_client ON app.onboarding_payment_requests (client_id, requested_at DESC);
CREATE INDEX idx_onboarding_payment_requests_matter ON app.onboarding_payment_requests (matter_id, requested_at DESC);
CREATE INDEX idx_onboarding_payment_requests_status ON app.onboarding_payment_requests (status, due_on);

-- Trigger to protect payment requests immutability
CREATE OR REPLACE FUNCTION app.protect_onboarding_payment_requests()
  RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment requests cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'paid payment requests cannot be modified' USING ERRCODE = '23514';
    END IF;

    IF OLD.id <> NEW.id OR
       OLD.client_id <> NEW.client_id OR
       ((OLD.matter_id IS NOT NULL OR NEW.matter_id IS NOT NULL) AND OLD.matter_id IS DISTINCT FROM NEW.matter_id) OR
       OLD.reference <> NEW.reference OR
       OLD.amount_pence <> NEW.amount_pence OR
       OLD.currency <> NEW.currency OR
       OLD.requested_by <> NEW.requested_by OR
       OLD.requested_at <> NEW.requested_at THEN
      RAISE EXCEPTION 'immutable fields of payment request cannot be changed' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER onboarding_payment_requests_protect
  BEFORE UPDATE OR DELETE ON app.onboarding_payment_requests
  FOR EACH ROW EXECUTE FUNCTION app.protect_onboarding_payment_requests();


-- 3. Stored Functions for PMS App

-- Create matter fee estimate
CREATE OR REPLACE FUNCTION app.create_matter_fee_estimate(
  target_matter uuid,
  selected_charging_basis text,
  selected_fees bigint,
  selected_disbursements bigint,
  selected_vat bigint,
  selected_budget_limit bigint,
  selected_assumptions text,
  selected_agreed boolean,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  matter_row app.matters%ROWTYPE;
  created_id uuid;
  next_version integer;
  calc_total bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner', 'accounts')
  ) THEN
    RAISE EXCEPTION 'only fee earner, partner or accounts can record fee estimates'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO matter_row FROM app.matters WHERE id = target_matter;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matter not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.matter_fee_estimates:' || target_matter, 0));

  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM app.matter_fee_estimates
  WHERE matter_id = target_matter;

  UPDATE app.matter_fee_estimates
  SET status = 'superseded'
  WHERE matter_id = target_matter AND status = 'active';

  calc_total := selected_fees + coalesce(selected_disbursements, 0) + coalesce(selected_vat, 0);

  INSERT INTO app.matter_fee_estimates (
    matter_id, client_id, version, charging_basis,
    estimated_fees_pence, estimated_disbursements_pence, estimated_vat_pence, total_estimate_pence,
    budget_limit_pence, currency, assumptions, status, agreed_with_client, created_by
  ) VALUES (
    target_matter, matter_row.client_id, next_version, selected_charging_basis,
    selected_fees, coalesce(selected_disbursements, 0), coalesce(selected_vat, 0), calc_total,
    selected_budget_limit, 'GBP', selected_assumptions, 'active', coalesce(selected_agreed, true), actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;


-- Create onboarding payment request
CREATE OR REPLACE FUNCTION app.create_onboarding_payment_request(
  target_client uuid,
  target_matter uuid,
  target_engagement_doc uuid,
  selected_kind text,
  selected_description text,
  selected_amount bigint,
  selected_due_on date,
  selected_bank_details jsonb,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  created_id uuid;
  gen_ref text;
  seq_num integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner', 'accounts')
  ) THEN
    RAISE EXCEPTION 'only fee earner, partner or accounts can create payment requests'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.clients WHERE id = target_client) THEN
    RAISE EXCEPTION 'client not found' USING ERRCODE = 'P0002';
  END IF;

  IF target_matter IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.matters WHERE id = target_matter) THEN
    RAISE EXCEPTION 'matter not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.onboarding_payment_requests:' || target_client, 0));

  SELECT coalesce(count(*), 0) + 1 INTO seq_num
  FROM app.onboarding_payment_requests
  WHERE client_id = target_client;

  LOOP
    gen_ref := 'PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)) || '-' || lpad(seq_num::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM app.onboarding_payment_requests WHERE reference = gen_ref);
  END LOOP;

  INSERT INTO app.onboarding_payment_requests (
    client_id, matter_id, engagement_document_id, reference, kind,
    description, amount_pence, currency, due_on, status,
    bank_account_details, requested_by
  ) VALUES (
    target_client, target_matter, target_engagement_doc, gen_ref, selected_kind,
    selected_description, selected_amount, 'GBP', selected_due_on, 'pending',
    selected_bank_details, actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;


-- Record onboarding payment receipt
CREATE OR REPLACE FUNCTION app.record_onboarding_payment_receipt(
  target_request uuid,
  selected_method text,
  selected_reference text,
  selected_notes text,
  actor_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req_row app.onboarding_payment_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner', 'accounts')
  ) THEN
    RAISE EXCEPTION 'only fee earner, partner or accounts can record payment receipts'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO req_row FROM app.onboarding_payment_requests WHERE id = target_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment request not found' USING ERRCODE = 'P0002';
  END IF;

  IF req_row.status <> 'pending' THEN
    RAISE EXCEPTION 'payment request is not pending' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.onboarding_payment_requests
  SET status = 'paid',
      payment_method = selected_method,
      paid_at = clock_timestamp(),
      paid_reference = selected_reference,
      notes = coalesce(selected_notes, notes),
      updated_by = actor_id,
      updated_at = clock_timestamp()
  WHERE id = target_request;
END;
$$;


-- Waive onboarding payment request
CREATE OR REPLACE FUNCTION app.waive_onboarding_payment_request(
  target_request uuid,
  selected_reason text,
  actor_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req_row app.onboarding_payment_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'accounts')
  ) THEN
    RAISE EXCEPTION 'only partner or accounts can waive payment requests'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO req_row FROM app.onboarding_payment_requests WHERE id = target_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment request not found' USING ERRCODE = 'P0002';
  END IF;

  IF req_row.status <> 'pending' THEN
    RAISE EXCEPTION 'payment request is not pending' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.onboarding_payment_requests
  SET status = 'waived',
      notes = selected_reason,
      updated_by = actor_id,
      updated_at = clock_timestamp()
  WHERE id = target_request;
END;
$$;


-- 4. Permissions and Grants
REVOKE ALL ON app.matter_fee_estimates FROM PUBLIC;
GRANT SELECT ON app.matter_fee_estimates TO pms_app;

REVOKE ALL ON app.onboarding_payment_requests FROM PUBLIC;
GRANT SELECT ON app.onboarding_payment_requests TO pms_app;

REVOKE ALL ON FUNCTION app.create_matter_fee_estimate(uuid, text, bigint, bigint, bigint, bigint, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_matter_fee_estimate(uuid, text, bigint, bigint, bigint, bigint, text, boolean, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.create_onboarding_payment_request(uuid, uuid, uuid, text, text, bigint, date, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_onboarding_payment_request(uuid, uuid, uuid, text, text, bigint, date, jsonb, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.record_onboarding_payment_receipt(uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_onboarding_payment_receipt(uuid, text, text, text, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.waive_onboarding_payment_request(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.waive_onboarding_payment_request(uuid, text, uuid) TO pms_app;
