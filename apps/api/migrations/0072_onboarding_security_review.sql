-- 0072_onboarding_security_review.sql
-- Security review hardening:
-- 1. Role concurrency protection: lock qualifying staff account and role rows with FOR SHARE
--    to prevent concurrent role revocation from racing in-flight onboarding and financial operations.
-- 2. Client-route scope verification: ensure operations targeting engagement documents and payment
--    requests verify client ownership when a client ID is provided, preventing route parameter cross-linking.

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
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'fee_earner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
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
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'fee_earner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
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


-- Record onboarding payment receipt with client-scope check and role row share lock (5-param version)
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
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'fee_earner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
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


-- Record onboarding payment receipt (6-param version with client scope)
CREATE OR REPLACE FUNCTION app.record_onboarding_payment_receipt(
  target_request uuid,
  selected_method text,
  selected_reference text,
  selected_notes text,
  actor_id uuid,
  target_client uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req_row app.onboarding_payment_requests%ROWTYPE;
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'fee_earner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only fee earner, partner or accounts can record payment receipts'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO req_row FROM app.onboarding_payment_requests WHERE id = target_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment request not found' USING ERRCODE = 'P0002';
  END IF;

  IF target_client IS NOT NULL AND req_row.client_id <> target_client THEN
    RAISE EXCEPTION 'payment request does not belong to client' USING ERRCODE = 'P0002';
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


-- Waive onboarding payment request with role share lock (3-param version)
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
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
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


-- Waive onboarding payment request (4-param version with client scope)
CREATE OR REPLACE FUNCTION app.waive_onboarding_payment_request(
  target_request uuid,
  selected_reason text,
  actor_id uuid,
  target_client uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req_row app.onboarding_payment_requests%ROWTYPE;
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'accounts')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only partner or accounts can waive payment requests'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO req_row FROM app.onboarding_payment_requests WHERE id = target_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment request not found' USING ERRCODE = 'P0002';
  END IF;

  IF target_client IS NOT NULL AND req_row.client_id <> target_client THEN
    RAISE EXCEPTION 'payment request does not belong to client' USING ERRCODE = 'P0002';
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


-- Send engagement document with role share lock
CREATE OR REPLACE FUNCTION app.send_engagement_document(
  target_doc uuid,
  target_expires timestamptz,
  actor_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc_row app.engagement_documents%ROWTYPE;
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'fee_earner')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only fee earner or partner can send engagement documents'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO doc_row FROM app.engagement_documents WHERE id = target_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement document not found' USING ERRCODE = 'P0002';
  END IF;

  IF doc_row.state NOT IN ('draft', 'declined') THEN
    RAISE EXCEPTION 'document can only be sent from draft or declined state'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.engagement_documents
  SET state = 'sent',
      sent_at = clock_timestamp(),
      expires_at = target_expires,
      declined_at = NULL,
      decline_reason = NULL
  WHERE id = target_doc;
END;
$$;


-- Record conflict decision with partner role share lock
CREATE OR REPLACE FUNCTION app.record_conflict_decision(
  target_check_id uuid,
  target_client_id uuid,
  target_outcome text,
  target_rationale text,
  target_safeguards text[],
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_id uuid := uuidv7();
  ch_row app.conflict_checks%ROWTYPE;
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role = 'partner'
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only partners can record conflict decisions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO ch_row FROM app.conflict_checks WHERE id = target_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conflict check not found' USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO app.conflict_decisions (id, check_id, client_id, outcome, rationale, safeguards, decided_by)
  VALUES (new_id, target_check_id, target_client_id, target_outcome, target_rationale, target_safeguards, actor_id);

  RETURN new_id;
END;
$$;


-- Grant activation exception with partner/compliance role share lock
CREATE OR REPLACE FUNCTION app.grant_activation_exception(
  target_client_id uuid,
  target_req_key text,
  target_reason text,
  target_expires_at timestamptz,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_id uuid := uuidv7();
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'compliance')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only partners or compliance staff can grant activation exceptions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO app.onboarding_activation_exceptions (id, client_id, requirement_key, reason, expires_at, granted_by)
  VALUES (new_id, target_client_id, target_req_key, target_reason, target_expires_at, actor_id);

  RETURN new_id;
END;
$$;


-- Activate client onboarding with partner/compliance role share lock
CREATE OR REPLACE FUNCTION app.activate_client_onboarding(
  target_client uuid,
  notes text,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  gate jsonb;
  new_id uuid := uuidv7();
BEGIN
  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles ar ON ar.account_id = a.id
  WHERE a.id = actor_id
    AND a.status = 'active'
    AND ar.revoked_at IS NULL
    AND ar.role IN ('partner', 'compliance')
  FOR SHARE OF a, ar;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only partners or compliance staff can formally activate a client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  gate := app.evaluate_client_activation_gate(target_client);
  IF gate IS NULL THEN
    RAISE EXCEPTION 'Client not found' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT (gate ->> 'canActivate')::boolean AND NOT (gate ->> 'isActivated')::boolean THEN
    RAISE EXCEPTION 'Client onboarding requirements are not satisfied'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.client_onboarding_activations (id, client_id, activated_by, notes)
  VALUES (new_id, target_client, actor_id, notes);

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION app.record_onboarding_payment_receipt(uuid, text, text, text, uuid, uuid) TO pms_app;
GRANT EXECUTE ON FUNCTION app.waive_onboarding_payment_request(uuid, text, uuid, uuid) TO pms_app;
