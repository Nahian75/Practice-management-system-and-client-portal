-- Finance 14d: client-money requests, four-eyes approval, reservations and bank outcomes.
CREATE TABLE app.client_payment_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  matter_id uuid NOT NULL REFERENCES app.matters(id),
  client_bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  business_bank_account_id uuid REFERENCES app.bank_accounts(id),
  bill_id uuid REFERENCES app.issued_bills(id),
  evidence_document_id uuid NOT NULL REFERENCES app.documents(id),
  purpose text NOT NULL,
  amount_pence bigint NOT NULL,
  payee_context uuid UNIQUE,
  payee_key_version smallint,
  payee_nonce bytea,
  payee_ciphertext bytea,
  payee_auth_tag bytea,
  requested_by uuid NOT NULL REFERENCES app.accounts(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_payment_requests_kind_valid CHECK (kind IN ('refund', 'third_party', 'costs_transfer')),
  CONSTRAINT client_payment_requests_purpose_valid CHECK (
    length(btrim(purpose)) BETWEEN 1 AND 500 AND app.is_safe_text(purpose)
  ),
  CONSTRAINT client_payment_requests_amount_valid CHECK (amount_pence BETWEEN 1 AND 100000000),
  CONSTRAINT client_payment_requests_payee_crypto_valid CHECK (
    (kind IN ('refund', 'third_party')
      AND business_bank_account_id IS NULL AND bill_id IS NULL
      AND payee_context IS NOT NULL AND payee_key_version BETWEEN 1 AND 32767
      AND octet_length(payee_nonce) = 12
      AND octet_length(payee_ciphertext) BETWEEN 1 AND 1000
      AND octet_length(payee_auth_tag) = 16)
    OR
    (kind = 'costs_transfer'
      AND business_bank_account_id IS NOT NULL AND bill_id IS NOT NULL
      AND payee_context IS NULL AND payee_key_version IS NULL
      AND payee_nonce IS NULL AND payee_ciphertext IS NULL AND payee_auth_tag IS NULL)
  )
);

CREATE INDEX client_payment_requests_matter_idx ON app.client_payment_requests (matter_id, id DESC);
CREATE INDEX client_payment_requests_bill_idx ON app.client_payment_requests (bill_id, id DESC)
  WHERE bill_id IS NOT NULL;

CREATE TABLE app.client_payment_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_request_id uuid NOT NULL REFERENCES app.client_payment_requests(id),
  kind text NOT NULL,
  reason text,
  bank_reference text,
  occurred_on date,
  finance_transaction_id uuid UNIQUE REFERENCES app.finance_transactions(id),
  acted_by uuid NOT NULL REFERENCES app.accounts(id),
  acted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_payment_events_kind_valid CHECK (
    kind IN ('approved', 'rejected', 'cancelled', 'paid', 'bank_rejected')
  ),
  CONSTRAINT client_payment_events_shape_valid CHECK (
    (kind = 'approved' AND reason IS NULL AND bank_reference IS NULL
      AND occurred_on IS NULL AND finance_transaction_id IS NULL)
    OR
    (kind IN ('rejected', 'cancelled', 'bank_rejected')
      AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500
      AND app.is_safe_text(reason) AND bank_reference IS NULL
      AND occurred_on IS NULL AND finance_transaction_id IS NULL)
    OR
    (kind = 'paid' AND reason IS NULL
      AND bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 1 AND 100
      AND app.is_safe_text(bank_reference) AND occurred_on >= DATE '1900-01-01'
      AND finance_transaction_id IS NOT NULL)
  )
);

CREATE INDEX client_payment_events_request_idx ON app.client_payment_events (payment_request_id, id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.client_payment_requests, app.client_payment_events FROM pms_app;

ALTER TABLE app.finance_transactions
  ADD COLUMN related_bank_account_id uuid REFERENCES app.bank_accounts(id),
  ADD COLUMN source_payment_request_id uuid UNIQUE REFERENCES app.client_payment_requests(id);

ALTER TABLE app.finance_transactions DROP CONSTRAINT finance_transactions_kind_valid;
ALTER TABLE app.finance_transactions ADD CONSTRAINT finance_transactions_kind_valid CHECK (kind IN (
  'bill', 'credit_note', 'client_receipt', 'business_receipt',
  'client_allocation', 'business_allocation', 'client_payment', 'costs_transfer'
));
ALTER TABLE app.finance_transactions DROP CONSTRAINT finance_transactions_shape_valid;
ALTER TABLE app.finance_transactions ADD CONSTRAINT finance_transactions_shape_valid CHECK (
  (kind = 'bill' AND bank_account_id IS NULL AND related_bank_account_id IS NULL
    AND related_matter_id IS NULL AND source_bill_id IS NOT NULL
    AND source_credit_note_id IS NULL AND source_payment_request_id IS NULL AND reference IS NOT NULL)
  OR
  (kind = 'credit_note' AND bank_account_id IS NULL AND related_bank_account_id IS NULL
    AND related_matter_id IS NULL AND source_bill_id IS NULL
    AND source_credit_note_id IS NOT NULL AND source_payment_request_id IS NULL AND reference IS NOT NULL)
  OR
  (kind IN ('client_receipt', 'business_receipt') AND bank_account_id IS NOT NULL
    AND related_bank_account_id IS NULL AND related_matter_id IS NULL
    AND source_bill_id IS NULL AND source_credit_note_id IS NULL
    AND source_payment_request_id IS NULL AND reference IS NOT NULL)
  OR
  (kind IN ('client_allocation', 'business_allocation') AND bank_account_id IS NULL
    AND related_bank_account_id IS NULL AND related_matter_id IS NOT NULL
    AND related_matter_id <> matter_id AND source_bill_id IS NULL
    AND source_credit_note_id IS NULL AND source_payment_request_id IS NULL AND reference IS NULL)
  OR
  (kind = 'client_payment' AND bank_account_id IS NOT NULL
    AND related_bank_account_id IS NULL AND related_matter_id IS NULL
    AND source_bill_id IS NULL AND source_credit_note_id IS NULL
    AND source_payment_request_id IS NOT NULL AND reference IS NOT NULL)
  OR
  (kind = 'costs_transfer' AND bank_account_id IS NOT NULL
    AND related_bank_account_id IS NOT NULL AND related_bank_account_id <> bank_account_id
    AND related_matter_id IS NULL AND source_bill_id IS NULL
    AND source_credit_note_id IS NULL AND source_payment_request_id IS NOT NULL
    AND reference IS NOT NULL)
);

CREATE UNIQUE INDEX finance_payment_reference_unique
  ON app.finance_transactions (bank_account_id, reference)
  WHERE kind IN ('client_payment', 'costs_transfer');

CREATE FUNCTION app.client_payment_state(target_request uuid) RETURNS text
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce((
      SELECT e.kind FROM app.client_payment_events e
      WHERE e.payment_request_id = target_request ORDER BY e.id DESC LIMIT 1
    ), 'pending')
  $$;

REVOKE ALL ON FUNCTION app.client_payment_state(uuid) FROM PUBLIC;

CREATE FUNCTION app.read_client_payment_payee(target_request uuid)
  RETURNS TABLE (
    context uuid, key_version smallint, nonce bytea, ciphertext bytea, auth_tag bytea
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  request app.client_payment_requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM app.client_payment_requests
  WHERE id = target_request FOR UPDATE;
  IF NOT FOUND OR request.kind = 'costs_transfer'
    OR app.client_payment_state(request.id) NOT IN ('pending', 'approved') THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT request.payee_context, request.payee_key_version,
    request.payee_nonce, request.payee_ciphertext, request.payee_auth_tag;
END;
$$;

REVOKE ALL ON FUNCTION app.read_client_payment_payee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_client_payment_payee(uuid) TO pms_app;

CREATE FUNCTION app.validate_client_payment_request() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_client uuid;
BEGIN
  PERFORM app.assert_active_accounts(NEW.requested_by);
  SELECT client_id INTO selected_client FROM app.matters
  WHERE id = NEW.matter_id AND status IN ('open', 'closed') FOR UPDATE;
  IF NOT FOUND OR selected_client <> NEW.client_id THEN
    RAISE EXCEPTION 'a payment request requires an open or closed matter and its client'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM app.bank_accounts b
  WHERE b.id IN (NEW.client_bank_account_id, NEW.business_bank_account_id)
  ORDER BY b.id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM app.bank_accounts b WHERE b.id = NEW.client_bank_account_id AND b.kind = 'client'
  ) OR EXISTS (
    SELECT 1 FROM app.bank_account_closures c WHERE c.bank_account_id = NEW.client_bank_account_id
  ) THEN
    RAISE EXCEPTION 'a payment request requires an open client bank account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.documents d
    WHERE d.id = NEW.evidence_document_id AND d.matter_id = NEW.matter_id
      AND EXISTS (SELECT 1 FROM app.document_versions v WHERE v.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM app.document_withdrawals w WHERE w.document_id = d.id)
  ) THEN
    RAISE EXCEPTION 'a payment request requires current supporting evidence on the matter'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'costs_transfer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.bank_accounts b
      WHERE b.id = NEW.business_bank_account_id AND b.kind = 'business'
    ) OR EXISTS (
      SELECT 1 FROM app.bank_account_closures c WHERE c.bank_account_id = NEW.business_bank_account_id
    ) THEN
      RAISE EXCEPTION 'a costs transfer requires an open business bank account'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM app.issued_bills b
    WHERE b.id = NEW.bill_id AND b.client_id = NEW.client_id AND b.matter_id = NEW.matter_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a costs transfer requires an issued bill for the matter'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_client_payment_request() FROM PUBLIC;
CREATE TRIGGER client_payment_requests_validate
  BEFORE INSERT ON app.client_payment_requests
  FOR EACH ROW EXECUTE FUNCTION app.validate_client_payment_request();

CREATE FUNCTION app.create_client_payment_request(
  selected_kind text, target_client_bank uuid, target_business_bank uuid,
  target_matter uuid, target_bill uuid, target_evidence uuid,
  selected_purpose text, selected_amount bigint,
  selected_payee_context uuid, selected_payee_key_version smallint,
  selected_payee_nonce bytea, selected_payee_ciphertext bytea, selected_payee_auth_tag bytea,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_client uuid;
  new_id uuid;
BEGIN
  SELECT client_id INTO selected_client FROM app.matters WHERE id = target_matter;
  IF selected_client IS NULL THEN
    RAISE EXCEPTION 'no matter with this id' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO app.client_payment_requests (
    kind, client_id, matter_id, client_bank_account_id, business_bank_account_id,
    bill_id, evidence_document_id, purpose, amount_pence,
    payee_context, payee_key_version, payee_nonce, payee_ciphertext, payee_auth_tag,
    requested_by
  ) VALUES (
    selected_kind, selected_client, target_matter, target_client_bank, target_business_bank,
    target_bill, target_evidence, selected_purpose, selected_amount,
    selected_payee_context, selected_payee_key_version, selected_payee_nonce,
    selected_payee_ciphertext, selected_payee_auth_tag, actor_id
  ) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_client_payment_request(
  text, uuid, uuid, uuid, uuid, uuid, text, bigint, uuid, smallint, bytea, bytea, bytea, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_client_payment_request(
  text, uuid, uuid, uuid, uuid, uuid, text, bigint, uuid, smallint, bytea, bytea, bytea, uuid
) TO pms_app;

CREATE FUNCTION app.validate_client_payment_event() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  request app.client_payment_requests%ROWTYPE;
  current_state text;
  client_balance numeric;
  reserved_balance numeric;
  bill_total numeric;
  bill_used numeric;
  source_bank app.bank_accounts%ROWTYPE;
BEGIN
  PERFORM app.assert_active_accounts(NEW.acted_by);
  SELECT * INTO request FROM app.client_payment_requests
  WHERE id = NEW.payment_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no payment request with this id' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM app.matters WHERE id = request.matter_id FOR UPDATE;
  PERFORM 1 FROM app.bank_accounts b
  WHERE b.id IN (request.client_bank_account_id, request.business_bank_account_id)
  ORDER BY b.id FOR UPDATE;
  current_state := app.client_payment_state(request.id);

  IF NEW.kind = 'approved' THEN
    IF current_state <> 'pending' OR NEW.acted_by = request.requested_by THEN
      RAISE EXCEPTION 'a pending request is approved by a different Accounts holder'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.bank_account_closures c
      WHERE c.bank_account_id IN (request.client_bank_account_id, request.business_bank_account_id)
    ) OR NOT EXISTS (
      SELECT 1 FROM app.documents d
      WHERE d.id = request.evidence_document_id AND d.matter_id = request.matter_id
        AND EXISTS (SELECT 1 FROM app.document_versions v WHERE v.document_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM app.document_withdrawals w WHERE w.document_id = d.id)
    ) THEN
      RAISE EXCEPTION 'the payment authority is no longer current'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END), 0)
    INTO client_balance FROM app.finance_postings p
    WHERE p.account = 'client_ledger' AND p.matter_id = request.matter_id;
    SELECT coalesce(sum(r.amount_pence), 0) INTO reserved_balance
    FROM app.client_payment_requests r
    WHERE r.matter_id = request.matter_id AND r.id <> request.id
      AND app.client_payment_state(r.id) = 'approved';
    IF client_balance - reserved_balance < request.amount_pence THEN
      RAISE EXCEPTION 'the matter has insufficient unreserved client money'
        USING ERRCODE = 'check_violation';
    END IF;
    IF request.kind = 'costs_transfer' THEN
      PERFORM 1 FROM app.issued_bills b WHERE b.id = request.bill_id FOR UPDATE;
      SELECT b.gross_pence - coalesce(sum(c.gross_pence), 0)
      INTO bill_total FROM app.issued_bills b
      LEFT JOIN app.credit_notes c ON c.bill_id = b.id
      WHERE b.id = request.bill_id GROUP BY b.id;
      SELECT coalesce(sum(r.amount_pence), 0) INTO bill_used
      FROM app.client_payment_requests r
      WHERE r.bill_id = request.bill_id AND r.id <> request.id
        AND app.client_payment_state(r.id) IN ('approved', 'paid');
      IF bill_total - bill_used < request.amount_pence THEN
        RAISE EXCEPTION 'the costs transfer exceeds the bill amount still available'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.kind = 'rejected' THEN
    IF current_state <> 'pending' OR NEW.acted_by = request.requested_by THEN
      RAISE EXCEPTION 'a pending request is rejected by a different Accounts holder'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'cancelled' THEN
    IF current_state NOT IN ('pending', 'approved') OR NEW.acted_by <> request.requested_by THEN
      RAISE EXCEPTION 'only the requester can cancel a pending or approved request'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'bank_rejected' THEN
    IF current_state <> 'approved' THEN
      RAISE EXCEPTION 'only an approved request can be rejected by the bank'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'paid' THEN
    IF current_state <> 'approved' THEN
      RAISE EXCEPTION 'only an approved request can be recorded as paid'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO source_bank FROM app.bank_accounts WHERE id = request.client_bank_account_id;
    IF NEW.occurred_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date
      OR NEW.occurred_on < source_bank.opened_on
      OR EXISTS (
        SELECT 1 FROM app.bank_account_closures c
        WHERE c.bank_account_id = source_bank.id AND NEW.occurred_on > c.closed_on
      )
    THEN
      RAISE EXCEPTION 'the paid date is outside the client bank account history'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app.finance_transactions t
      WHERE t.id = NEW.finance_transaction_id AND t.source_payment_request_id = request.id
        AND t.client_id = request.client_id AND t.matter_id = request.matter_id
        AND t.amount_pence = request.amount_pence
        AND t.kind = CASE request.kind WHEN 'costs_transfer' THEN 'costs_transfer' ELSE 'client_payment' END
        AND t.bank_account_id = request.client_bank_account_id
        AND t.related_bank_account_id IS NOT DISTINCT FROM request.business_bank_account_id
    ) THEN
      RAISE EXCEPTION 'the paid event requires its matching finance transaction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF request.kind = 'costs_transfer' THEN
      PERFORM 1 FROM app.issued_bills b WHERE b.id = request.bill_id FOR UPDATE;
      SELECT b.gross_pence - coalesce(sum(c.gross_pence), 0)
      INTO bill_total FROM app.issued_bills b
      LEFT JOIN app.credit_notes c ON c.bill_id = b.id
      WHERE b.id = request.bill_id GROUP BY b.id;
      SELECT coalesce(sum(r.amount_pence), 0) INTO bill_used
      FROM app.client_payment_requests r
      WHERE r.bill_id = request.bill_id AND r.id <> request.id
        AND app.client_payment_state(r.id) = 'paid';
      IF bill_total - bill_used < request.amount_pence THEN
        RAISE EXCEPTION 'the costs transfer exceeds the bill amount still available'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_client_payment_event() FROM PUBLIC;
CREATE TRIGGER client_payment_events_validate
  BEFORE INSERT ON app.client_payment_events
  FOR EACH ROW EXECUTE FUNCTION app.validate_client_payment_event();

CREATE FUNCTION app.record_client_payment_event(
  target_request uuid, selected_kind text, selected_reason text,
  selected_bank_reference text, selected_occurred_on date, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  request app.client_payment_requests%ROWTYPE;
  new_transaction uuid;
  new_event uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO request FROM app.client_payment_requests WHERE id = target_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no payment request with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF selected_kind = 'paid' THEN
    IF app.client_payment_state(request.id) <> 'approved' THEN
      RAISE EXCEPTION 'only an approved request can be recorded as paid'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.finance_transactions (
      kind, client_id, matter_id, bank_account_id, related_bank_account_id,
      source_payment_request_id, reference, purpose, amount_pence, occurred_on, posted_by
    ) VALUES (
      CASE request.kind WHEN 'costs_transfer' THEN 'costs_transfer' ELSE 'client_payment' END,
      request.client_id, request.matter_id, request.client_bank_account_id,
      request.business_bank_account_id, request.id, selected_bank_reference,
      request.purpose, request.amount_pence, selected_occurred_on, actor_id
    ) RETURNING id INTO new_transaction;
    INSERT INTO app.finance_postings (
      transaction_id, position, account, direction, amount_pence, client_id,
      matter_id, bank_account_id
    ) VALUES
      (new_transaction, 1, 'client_ledger', 'debit', request.amount_pence,
        request.client_id, request.matter_id, NULL),
      (new_transaction, 2, 'client_bank', 'credit', request.amount_pence,
        request.client_id, request.matter_id, request.client_bank_account_id);
    IF request.kind = 'costs_transfer' THEN
      INSERT INTO app.finance_postings (
        transaction_id, position, account, direction, amount_pence, client_id,
        matter_id, bank_account_id
      ) VALUES
        (new_transaction, 3, 'business_bank', 'debit', request.amount_pence,
          request.client_id, request.matter_id, request.business_bank_account_id),
        (new_transaction, 4, 'business_ledger', 'credit', request.amount_pence,
          request.client_id, request.matter_id, NULL);
    END IF;
  END IF;
  INSERT INTO app.client_payment_events (
    payment_request_id, kind, reason, bank_reference, occurred_on,
    finance_transaction_id, acted_by
  ) VALUES (
    request.id, selected_kind, selected_reason, selected_bank_reference,
    selected_occurred_on, new_transaction, actor_id
  ) RETURNING id INTO new_event;
  RETURN new_event;
END;
$$;

REVOKE ALL ON FUNCTION app.record_client_payment_event(uuid, text, text, text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_client_payment_event(uuid, text, text, text, date, uuid) TO pms_app;

CREATE OR REPLACE FUNCTION app.validate_finance_transaction() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  target_transaction uuid;
  selected app.finance_transactions%ROWTYPE;
  posting_count integer;
  debit_total numeric;
  credit_total numeric;
  expected_total numeric;
  expected_posting_count integer;
BEGIN
  IF TG_TABLE_NAME = 'finance_transactions' THEN target_transaction := NEW.id;
  ELSE target_transaction := NEW.transaction_id;
  END IF;
  SELECT * INTO selected FROM app.finance_transactions WHERE id = target_transaction;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a posting requires its transaction' USING ERRCODE = 'check_violation';
  END IF;
  expected_total := selected.amount_pence * CASE selected.kind WHEN 'costs_transfer' THEN 2 ELSE 1 END;
  expected_posting_count := CASE selected.kind WHEN 'costs_transfer' THEN 4 ELSE 2 END;
  SELECT count(*), coalesce(sum(amount_pence) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount_pence) FILTER (WHERE direction = 'credit'), 0)
  INTO posting_count, debit_total, credit_total
  FROM app.finance_postings WHERE transaction_id = target_transaction;
  IF posting_count <> expected_posting_count
    OR debit_total <> expected_total OR credit_total <> expected_total
  THEN
    RAISE EXCEPTION 'a finance transaction must have balanced postings'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.finance_postings p
    WHERE p.transaction_id = target_transaction
      AND (p.amount_pence <> selected.amount_pence OR p.client_id <> selected.client_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM app.matters m WHERE m.id = selected.matter_id AND m.client_id = selected.client_id
  ) OR (selected.related_matter_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.matters m
    WHERE m.id = selected.related_matter_id AND m.client_id = selected.client_id
  )) OR EXISTS (
    SELECT 1 FROM app.finance_postings p JOIN app.matters m ON m.id = p.matter_id
    WHERE p.transaction_id = target_transaction AND m.client_id <> selected.client_id
  ) THEN
    RAISE EXCEPTION 'finance transaction client and matter links do not agree'
      USING ERRCODE = 'check_violation';
  END IF;
  IF selected.kind = 'bill' THEN
    IF NOT EXISTS (SELECT 1 FROM app.issued_bills b WHERE b.id = selected.source_bill_id
      AND b.client_id = selected.client_id AND b.matter_id = selected.matter_id
      AND b.gross_pence = selected.amount_pence)
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_ledger' AND p.direction = 'debit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_control' AND p.direction = 'credit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1 THEN
      RAISE EXCEPTION 'bill postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM app.credit_notes c JOIN app.issued_bills b ON b.id = c.bill_id
      WHERE c.id = selected.source_credit_note_id AND b.client_id = selected.client_id
        AND b.matter_id = selected.matter_id AND c.gross_pence = selected.amount_pence)
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_control' AND p.direction = 'debit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_ledger' AND p.direction = 'credit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1 THEN
      RAISE EXCEPTION 'credit note postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind IN ('client_receipt', 'business_receipt') THEN
    IF NOT EXISTS (SELECT 1 FROM app.bank_accounts b WHERE b.id = selected.bank_account_id
      AND b.kind = CASE selected.kind WHEN 'client_receipt' THEN 'client' ELSE 'business' END)
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = CASE selected.kind WHEN 'client_receipt' THEN 'client_bank' ELSE 'business_bank' END
        AND p.direction = 'debit' AND p.matter_id = selected.matter_id
        AND p.bank_account_id = selected.bank_account_id) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = CASE selected.kind WHEN 'client_receipt' THEN 'client_ledger' ELSE 'business_ledger' END
        AND p.direction = 'credit' AND p.matter_id = selected.matter_id
        AND p.bank_account_id IS NULL) <> 1 THEN
      RAISE EXCEPTION 'receipt postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind IN ('client_allocation', 'business_allocation') THEN
    IF (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
      AND p.account = CASE selected.kind WHEN 'client_allocation' THEN 'client_ledger' ELSE 'business_ledger' END
      AND p.direction = 'debit' AND p.matter_id = selected.matter_id
      AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = CASE selected.kind WHEN 'client_allocation' THEN 'client_ledger' ELSE 'business_ledger' END
        AND p.direction = 'credit' AND p.matter_id = selected.related_matter_id
        AND p.bank_account_id IS NULL) <> 1 THEN
      RAISE EXCEPTION 'allocation postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind = 'client_payment' THEN
    IF NOT EXISTS (SELECT 1 FROM app.client_payment_requests r WHERE r.id = selected.source_payment_request_id
      AND r.kind IN ('refund', 'third_party') AND r.client_id = selected.client_id
      AND r.matter_id = selected.matter_id AND r.client_bank_account_id = selected.bank_account_id
      AND r.amount_pence = selected.amount_pence)
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'client_ledger' AND p.direction = 'debit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'client_bank' AND p.direction = 'credit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id = selected.bank_account_id) <> 1 THEN
      RAISE EXCEPTION 'client payment postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind = 'costs_transfer' THEN
    IF NOT EXISTS (SELECT 1 FROM app.client_payment_requests r WHERE r.id = selected.source_payment_request_id
      AND r.kind = 'costs_transfer' AND r.client_id = selected.client_id
      AND r.matter_id = selected.matter_id AND r.client_bank_account_id = selected.bank_account_id
      AND r.business_bank_account_id = selected.related_bank_account_id
      AND r.amount_pence = selected.amount_pence)
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'client_ledger' AND p.direction = 'debit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'client_bank' AND p.direction = 'credit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id = selected.bank_account_id) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_bank' AND p.direction = 'debit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id = selected.related_bank_account_id) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
        AND p.account = 'business_ledger' AND p.direction = 'credit'
        AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1 THEN
      RAISE EXCEPTION 'costs transfer postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.record_finance_allocation(
  selected_side text, source_matter uuid, target_matter uuid,
  selected_amount bigint, selected_reason text, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  source_client uuid;
  target_client uuid;
  available numeric;
  reserved numeric;
  new_transaction uuid;
  selected_account text;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  IF source_matter = target_matter THEN
    RAISE EXCEPTION 'an allocation needs two different matters' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_side NOT IN ('client', 'business') THEN
    RAISE EXCEPTION 'the allocation side is not valid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM app.matters m
  WHERE m.id IN (source_matter, target_matter) AND m.status IN ('open', 'closed')
  ORDER BY m.id FOR UPDATE;
  SELECT client_id INTO source_client FROM app.matters
  WHERE id = source_matter AND status IN ('open', 'closed');
  SELECT client_id INTO target_client FROM app.matters
  WHERE id = target_matter AND status IN ('open', 'closed');
  IF source_client IS NULL OR target_client IS NULL THEN
    RAISE EXCEPTION 'an allocation requires two open or closed matters' USING ERRCODE = 'no_data_found';
  END IF;
  IF source_client <> target_client THEN
    RAISE EXCEPTION 'an allocation cannot move money between clients' USING ERRCODE = 'check_violation';
  END IF;
  selected_account := CASE selected_side WHEN 'client' THEN 'client_ledger' ELSE 'business_ledger' END;
  IF selected_side = 'client' THEN
    SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_pence ELSE -amount_pence END), 0)
    INTO available FROM app.finance_postings
    WHERE account = 'client_ledger' AND matter_id = source_matter;
    SELECT coalesce(sum(r.amount_pence), 0) INTO reserved
    FROM app.client_payment_requests r
    WHERE r.matter_id = source_matter AND app.client_payment_state(r.id) = 'approved';
    IF available - reserved < selected_amount THEN
      RAISE EXCEPTION 'the source matter has insufficient client money after reservations'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO app.finance_transactions (
    kind, client_id, matter_id, related_matter_id, purpose,
    amount_pence, occurred_on, posted_by
  ) VALUES (
    selected_side || '_allocation', source_client, source_matter, target_matter,
    selected_reason, selected_amount,
    (clock_timestamp() AT TIME ZONE 'Europe/London')::date, actor_id
  ) RETURNING id INTO new_transaction;
  INSERT INTO app.finance_postings (
    transaction_id, position, account, direction, amount_pence, client_id, matter_id
  ) VALUES
    (new_transaction, 1, selected_account, 'debit', selected_amount, source_client, source_matter),
    (new_transaction, 2, selected_account, 'credit', selected_amount, source_client, target_matter);
  RETURN new_transaction;
END;
$$;

CREATE OR REPLACE FUNCTION app.close_bank_account(
  target_account uuid, selected_closed_on date, selected_reason text, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_account app.bank_accounts%ROWTYPE;
  new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO selected_account FROM app.bank_accounts WHERE id = target_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no bank account with this id' USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM app.bank_account_closures c WHERE c.bank_account_id = target_account) THEN
    RAISE EXCEPTION 'this bank account is already closed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.client_payment_requests r
    WHERE target_account IN (r.client_bank_account_id, r.business_bank_account_id)
      AND app.client_payment_state(r.id) = 'approved'
  ) THEN
    RAISE EXCEPTION 'a bank account with an approved payment cannot be closed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF selected_closed_on < selected_account.opened_on
    OR selected_closed_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'the bank account closure date is not valid' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_account_closures (bank_account_id, closed_on, reason, closed_by)
  VALUES (target_account, selected_closed_on, selected_reason, actor_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION app.prevent_credit_below_paid_costs() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bill_total numeric;
  prior_credits numeric;
  paid_costs numeric;
BEGIN
  SELECT gross_pence INTO bill_total FROM app.issued_bills WHERE id = NEW.bill_id FOR UPDATE;
  SELECT coalesce(sum(gross_pence), 0) INTO prior_credits
  FROM app.credit_notes WHERE bill_id = NEW.bill_id;
  SELECT coalesce(sum(r.amount_pence), 0) INTO paid_costs
  FROM app.client_payment_requests r
  WHERE r.bill_id = NEW.bill_id AND app.client_payment_state(r.id) = 'paid';
  IF bill_total - prior_credits - NEW.gross_pence < paid_costs THEN
    RAISE EXCEPTION 'the credit would exceed the bill balance after paid costs transfers'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.prevent_credit_below_paid_costs() FROM PUBLIC;
CREATE TRIGGER credit_notes_preserve_paid_costs
  BEFORE INSERT ON app.credit_notes FOR EACH ROW EXECUTE FUNCTION app.prevent_credit_below_paid_costs();

CREATE FUNCTION app.refuse_client_payment_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'client payment records cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_client_payment_edit() FROM PUBLIC;
CREATE TRIGGER client_payment_requests_fixed BEFORE UPDATE OR DELETE ON app.client_payment_requests
  FOR EACH ROW EXECUTE FUNCTION app.refuse_client_payment_edit();
CREATE TRIGGER client_payment_events_fixed BEFORE UPDATE OR DELETE ON app.client_payment_events
  FOR EACH ROW EXECUTE FUNCTION app.refuse_client_payment_edit();
CREATE TRIGGER client_payment_requests_no_truncate BEFORE TRUNCATE ON app.client_payment_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_client_payment_edit();
CREATE TRIGGER client_payment_events_no_truncate BEFORE TRUNCATE ON app.client_payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_client_payment_edit();
