-- Finance 14e: safe statement imports, immutable matching and five-week reconciliation.
CREATE TABLE app.bank_statement_imports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_balance_pence bigint NOT NULL,
  closing_balance_pence bigint NOT NULL,
  file_name text NOT NULL,
  file_hash bytea NOT NULL,
  row_count integer NOT NULL,
  imported_by uuid NOT NULL REFERENCES app.accounts(id),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bank_statement_import_dates_valid CHECK (
    period_start >= DATE '1900-01-01' AND period_end >= period_start
  ),
  CONSTRAINT bank_statement_import_balances_valid CHECK (
    opening_balance_pence BETWEEN -1000000000000 AND 1000000000000
    AND closing_balance_pence BETWEEN -1000000000000 AND 1000000000000
  ),
  CONSTRAINT bank_statement_import_file_name_valid CHECK (
    length(btrim(file_name)) BETWEEN 1 AND 255 AND app.is_safe_text(file_name)
  ),
  CONSTRAINT bank_statement_import_hash_valid CHECK (octet_length(file_hash) = 32),
  CONSTRAINT bank_statement_import_row_count_valid CHECK (row_count BETWEEN 1 AND 10000),
  CONSTRAINT bank_statement_import_file_unique UNIQUE (bank_account_id, file_hash)
);

CREATE TABLE app.bank_statement_rows (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  statement_import_id uuid NOT NULL REFERENCES app.bank_statement_imports(id),
  bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  row_number integer NOT NULL,
  occurred_on date NOT NULL,
  amount_pence bigint NOT NULL,
  reference text NOT NULL,
  description text NOT NULL,
  row_fingerprint bytea NOT NULL,
  CONSTRAINT bank_statement_rows_number_valid CHECK (row_number BETWEEN 1 AND 10000),
  CONSTRAINT bank_statement_rows_date_valid CHECK (occurred_on >= DATE '1900-01-01'),
  CONSTRAINT bank_statement_rows_amount_valid CHECK (
    amount_pence BETWEEN -100000000000 AND 100000000000 AND amount_pence <> 0
  ),
  CONSTRAINT bank_statement_rows_reference_valid CHECK (
    length(btrim(reference)) BETWEEN 1 AND 100 AND app.is_safe_text(reference)
  ),
  CONSTRAINT bank_statement_rows_description_valid CHECK (
    length(btrim(description)) BETWEEN 1 AND 500 AND app.is_safe_text(description)
  ),
  CONSTRAINT bank_statement_rows_fingerprint_valid CHECK (octet_length(row_fingerprint) = 32),
  CONSTRAINT bank_statement_rows_position_unique UNIQUE (statement_import_id, row_number),
  CONSTRAINT bank_statement_rows_duplicate_unique UNIQUE (bank_account_id, row_fingerprint)
);

CREATE INDEX bank_statement_imports_bank_period_idx
  ON app.bank_statement_imports (bank_account_id, period_end DESC, id DESC);
CREATE INDEX bank_statement_rows_bank_date_idx
  ON app.bank_statement_rows (bank_account_id, occurred_on, id);

CREATE TABLE app.bank_statement_match_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,
  statement_row_id uuid NOT NULL REFERENCES app.bank_statement_rows(id),
  finance_transaction_id uuid REFERENCES app.finance_transactions(id),
  reversed_match_id uuid REFERENCES app.bank_statement_match_events(id),
  reason text,
  acted_by uuid NOT NULL REFERENCES app.accounts(id),
  acted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bank_statement_match_events_kind_valid CHECK (kind IN ('matched', 'reversed')),
  CONSTRAINT bank_statement_match_events_shape_valid CHECK (
    (kind = 'matched' AND finance_transaction_id IS NOT NULL AND reversed_match_id IS NULL AND reason IS NULL)
    OR (kind = 'reversed' AND finance_transaction_id IS NULL AND reversed_match_id IS NOT NULL
      AND reason IS NOT NULL)
  ),
  CONSTRAINT bank_statement_match_events_reason_valid CHECK (
    reason IS NULL OR (length(btrim(reason)) BETWEEN 1 AND 500 AND app.is_safe_text(reason))
  ),
  CONSTRAINT bank_statement_match_events_reversal_unique UNIQUE (reversed_match_id)
);

CREATE INDEX bank_statement_match_events_row_idx
  ON app.bank_statement_match_events (statement_row_id, id);
CREATE INDEX bank_statement_match_events_transaction_idx
  ON app.bank_statement_match_events (finance_transaction_id, id)
  WHERE finance_transaction_id IS NOT NULL;

CREATE TABLE app.client_account_reconciliations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  as_of date NOT NULL,
  bank_balance_pence bigint NOT NULL,
  cashbook_balance_pence bigint NOT NULL,
  client_ledger_balance_pence bigint NOT NULL,
  bank_cashbook_difference_pence bigint NOT NULL,
  cashbook_client_difference_pence bigint NOT NULL,
  prepared_by uuid NOT NULL REFERENCES app.accounts(id),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_account_reconciliations_date_valid CHECK (as_of >= DATE '1900-01-01')
);

CREATE TABLE app.client_account_reconciliation_statements (
  reconciliation_id uuid NOT NULL REFERENCES app.client_account_reconciliations(id),
  statement_import_id uuid NOT NULL REFERENCES app.bank_statement_imports(id),
  bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  PRIMARY KEY (reconciliation_id, bank_account_id),
  UNIQUE (reconciliation_id, statement_import_id)
);

CREATE TABLE app.client_account_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  reconciliation_id uuid NOT NULL REFERENCES app.client_account_reconciliations(id),
  kind text NOT NULL,
  source_key text NOT NULL,
  bank_account_id uuid REFERENCES app.bank_accounts(id),
  occurred_on date,
  amount_pence bigint NOT NULL,
  reference text,
  explanation text NOT NULL,
  CONSTRAINT client_account_reconciliation_items_kind_valid CHECK (
    kind IN ('unmatched_statement', 'unmatched_cashbook', 'difference')
  ),
  CONSTRAINT client_account_reconciliation_items_key_valid CHECK (
    length(source_key) BETWEEN 1 AND 200 AND app.is_safe_text(source_key)
  ),
  CONSTRAINT client_account_reconciliation_items_reference_valid CHECK (
    reference IS NULL OR (length(btrim(reference)) BETWEEN 1 AND 100 AND app.is_safe_text(reference))
  ),
  CONSTRAINT client_account_reconciliation_items_explanation_valid CHECK (
    length(btrim(explanation)) BETWEEN 1 AND 1000 AND app.is_safe_text(explanation)
  ),
  CONSTRAINT client_account_reconciliation_items_source_unique UNIQUE (reconciliation_id, source_key)
);

CREATE TABLE app.client_account_reconciliation_sign_offs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  reconciliation_id uuid NOT NULL UNIQUE REFERENCES app.client_account_reconciliations(id),
  signed_off_by uuid NOT NULL REFERENCES app.accounts(id),
  signed_off_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.bank_statement_imports, app.bank_statement_rows, app.bank_statement_match_events,
  app.client_account_reconciliations, app.client_account_reconciliation_statements,
  app.client_account_reconciliation_items, app.client_account_reconciliation_sign_offs
  FROM pms_app;

CREATE FUNCTION app.assert_active_compliance(actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.accounts a JOIN app.account_roles r ON r.account_id = a.id
    WHERE a.id = actor_id AND a.kind = 'staff' AND a.status = 'active'
      AND r.role = 'compliance' AND r.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an active compliance role is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_active_compliance(uuid) FROM PUBLIC;

CREATE FUNCTION app.create_bank_statement_import(
  target_bank uuid, selected_start date, selected_end date,
  selected_opening bigint, selected_closing bigint, selected_file_name text,
  selected_hash bytea, selected_rows jsonb, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  selected_bank app.bank_accounts%ROWTYPE;
  new_id uuid;
  row_value jsonb;
  row_total numeric := 0;
  rows_seen integer := 0;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO selected_bank FROM app.bank_accounts WHERE id = target_bank FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no bank account with this id' USING ERRCODE = 'no_data_found'; END IF;
  IF selected_start < selected_bank.opened_on OR selected_end < selected_start
    OR selected_end > (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    OR EXISTS (SELECT 1 FROM app.bank_account_closures c
      WHERE c.bank_account_id = target_bank AND selected_end > c.closed_on) THEN
    RAISE EXCEPTION 'the statement period is outside the bank account history'
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(selected_rows) <> 'array' OR jsonb_array_length(selected_rows) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'a statement needs between one and 10000 rows' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_statement_imports (
    bank_account_id, period_start, period_end, opening_balance_pence,
    closing_balance_pence, file_name, file_hash, row_count, imported_by
  ) VALUES (
    target_bank, selected_start, selected_end, selected_opening, selected_closing,
    selected_file_name, selected_hash, jsonb_array_length(selected_rows), actor_id
  ) RETURNING id INTO new_id;
  FOR row_value IN SELECT value FROM jsonb_array_elements(selected_rows) LOOP
    rows_seen := rows_seen + 1;
    IF (row_value ->> 'occurred_on')::date NOT BETWEEN selected_start AND selected_end THEN
      RAISE EXCEPTION 'a statement row date is outside its period' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.bank_statement_rows (
      statement_import_id, bank_account_id, row_number, occurred_on, amount_pence,
      reference, description, row_fingerprint
    ) VALUES (
      new_id, target_bank, rows_seen, (row_value ->> 'occurred_on')::date,
      (row_value ->> 'amount_pence')::bigint, row_value ->> 'reference',
      row_value ->> 'description', decode(row_value ->> 'fingerprint', 'base64')
    );
    row_total := row_total + (row_value ->> 'amount_pence')::bigint;
  END LOOP;
  IF selected_opening + row_total <> selected_closing THEN
    RAISE EXCEPTION 'statement rows do not reconcile opening and closing balances'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_bank_statement_import(
  uuid, date, date, bigint, bigint, text, bytea, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_bank_statement_import(
  uuid, date, date, bigint, bigint, text, bytea, jsonb, uuid
) TO pms_app;

CREATE FUNCTION app.match_bank_statement_row(
  target_row uuid, target_transaction uuid, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  selected_row app.bank_statement_rows%ROWTYPE;
  selected_transaction app.finance_transactions%ROWTYPE;
  bank_amount numeric;
  new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO selected_row FROM app.bank_statement_rows WHERE id = target_row FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no statement row with this id' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO selected_transaction FROM app.finance_transactions
    WHERE id = target_transaction FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no finance transaction with this id' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM 1 FROM app.bank_accounts WHERE id = selected_row.bank_account_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM app.bank_statement_match_events m
    WHERE m.kind = 'matched' AND m.statement_row_id = target_row
      AND NOT EXISTS (SELECT 1 FROM app.bank_statement_match_events r
        WHERE r.kind = 'reversed' AND r.reversed_match_id = m.id)
  ) THEN RAISE EXCEPTION 'the statement row is already matched' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (
    SELECT 1 FROM app.bank_statement_match_events m
    JOIN app.bank_statement_rows sr ON sr.id = m.statement_row_id
    WHERE m.kind = 'matched' AND m.finance_transaction_id = target_transaction
      AND sr.bank_account_id = selected_row.bank_account_id
      AND NOT EXISTS (SELECT 1 FROM app.bank_statement_match_events r
        WHERE r.kind = 'reversed' AND r.reversed_match_id = m.id)
  ) THEN RAISE EXCEPTION 'the finance transaction is already matched for this bank account'
    USING ERRCODE = 'check_violation'; END IF;
  SELECT coalesce(sum(CASE p.direction WHEN 'debit' THEN p.amount_pence ELSE -p.amount_pence END), 0)
    INTO bank_amount FROM app.finance_postings p
    WHERE p.transaction_id = target_transaction AND p.bank_account_id = selected_row.bank_account_id
      AND p.account IN ('client_bank', 'business_bank');
  IF bank_amount = 0 OR bank_amount <> selected_row.amount_pence
    OR selected_transaction.occurred_on <> selected_row.occurred_on
    OR selected_transaction.reference IS DISTINCT FROM selected_row.reference THEN
    RAISE EXCEPTION 'the account, amount, date and reference must match the posted transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_statement_match_events (
    kind, statement_row_id, finance_transaction_id, acted_by
  ) VALUES ('matched', target_row, target_transaction, actor_id) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION app.match_bank_statement_row(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.match_bank_statement_row(uuid, uuid, uuid) TO pms_app;

CREATE FUNCTION app.reverse_bank_statement_match(
  target_match uuid, selected_reason text, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected_match app.bank_statement_match_events%ROWTYPE; new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO selected_match FROM app.bank_statement_match_events
    WHERE id = target_match AND kind = 'matched' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no bank match with this id' USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM app.bank_statement_match_events WHERE reversed_match_id = target_match) THEN
    RAISE EXCEPTION 'the bank match is already reversed' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_statement_match_events (
    kind, statement_row_id, reversed_match_id, reason, acted_by
  ) VALUES ('reversed', selected_match.statement_row_id, target_match, selected_reason, actor_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION app.reverse_bank_statement_match(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reverse_bank_statement_match(uuid, text, uuid) TO pms_app;

CREATE FUNCTION app.prepare_client_account_reconciliation(
  selected_as_of date, selected_imports uuid[], explanations jsonb, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_id uuid; open_count integer; selected_count integer;
  bank_total numeric; cashbook_total numeric; client_total numeric;
  item record; item_explanation text;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  IF selected_as_of > (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    OR selected_as_of < DATE '1900-01-01' THEN
    RAISE EXCEPTION 'the reconciliation date is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF explanations IS NULL OR jsonb_typeof(explanations) <> 'object' THEN
    RAISE EXCEPTION 'reconciliation explanations must be an object' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM app.bank_accounts b WHERE b.kind = 'client' ORDER BY b.id FOR UPDATE;
  SELECT count(*) INTO open_count FROM app.bank_accounts b
    WHERE b.kind = 'client' AND b.opened_on <= selected_as_of
      AND NOT EXISTS (SELECT 1 FROM app.bank_account_closures c
        WHERE c.bank_account_id = b.id AND c.closed_on < selected_as_of);
  SELECT count(*), coalesce(sum(i.closing_balance_pence), 0) INTO selected_count, bank_total
    FROM app.bank_statement_imports i JOIN app.bank_accounts b ON b.id = i.bank_account_id
    WHERE i.id = ANY(selected_imports) AND b.kind = 'client' AND i.period_end = selected_as_of;
  IF open_count = 0 OR selected_count <> open_count
    OR selected_count <> cardinality(selected_imports)
    OR (SELECT count(DISTINCT i.bank_account_id) FROM app.bank_statement_imports i
        WHERE i.id = ANY(selected_imports)) <> open_count
    OR EXISTS (
      SELECT 1 FROM app.bank_accounts b WHERE b.kind = 'client' AND b.opened_on <= selected_as_of
        AND NOT EXISTS (SELECT 1 FROM app.bank_account_closures c
          WHERE c.bank_account_id = b.id AND c.closed_on < selected_as_of)
        AND NOT EXISTS (SELECT 1 FROM app.bank_statement_imports i
          WHERE i.id = ANY(selected_imports) AND i.bank_account_id = b.id AND i.period_end = selected_as_of)
    ) THEN RAISE EXCEPTION 'select one statement ending on the reconciliation date for every open client account'
      USING ERRCODE = 'check_violation'; END IF;
  SELECT coalesce(sum(CASE p.direction WHEN 'debit' THEN p.amount_pence ELSE -p.amount_pence END), 0)
    INTO cashbook_total FROM app.finance_postings p JOIN app.finance_transactions t ON t.id = p.transaction_id
    WHERE p.account = 'client_bank' AND t.occurred_on <= selected_as_of
      AND p.bank_account_id IN (SELECT i.bank_account_id FROM app.bank_statement_imports i WHERE i.id = ANY(selected_imports));
  SELECT coalesce(sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END), 0)
    INTO client_total FROM app.finance_postings p JOIN app.finance_transactions t ON t.id = p.transaction_id
    WHERE p.account = 'client_ledger' AND t.occurred_on <= selected_as_of;
  INSERT INTO app.client_account_reconciliations (
    as_of, bank_balance_pence, cashbook_balance_pence, client_ledger_balance_pence,
    bank_cashbook_difference_pence, cashbook_client_difference_pence, prepared_by
  ) VALUES (
    selected_as_of, bank_total, cashbook_total, client_total,
    bank_total - cashbook_total, cashbook_total - client_total, actor_id
  ) RETURNING id INTO new_id;
  INSERT INTO app.client_account_reconciliation_statements (
    reconciliation_id, statement_import_id, bank_account_id
  ) SELECT new_id, i.id, i.bank_account_id FROM app.bank_statement_imports i
    WHERE i.id = ANY(selected_imports);
  FOR item IN
    SELECT 'unmatched_statement'::text AS kind, 'statement:' || sr.id AS source_key,
      sr.bank_account_id, sr.occurred_on, sr.amount_pence, sr.reference
    FROM app.bank_statement_rows sr
    JOIN app.bank_statement_imports si ON si.id = sr.statement_import_id
    WHERE sr.bank_account_id IN (SELECT i.bank_account_id FROM app.bank_statement_imports i WHERE i.id = ANY(selected_imports))
      AND si.period_end <= selected_as_of AND sr.occurred_on <= selected_as_of AND NOT EXISTS (
        SELECT 1 FROM app.bank_statement_match_events m WHERE m.kind = 'matched'
          AND m.statement_row_id = sr.id AND NOT EXISTS (
            SELECT 1 FROM app.bank_statement_match_events r WHERE r.kind = 'reversed' AND r.reversed_match_id = m.id))
    UNION ALL
    SELECT 'unmatched_cashbook', 'cashbook:' || p.transaction_id || ':' || p.bank_account_id,
      p.bank_account_id, t.occurred_on,
      CASE p.direction WHEN 'debit' THEN p.amount_pence ELSE -p.amount_pence END, t.reference
    FROM app.finance_postings p JOIN app.finance_transactions t ON t.id = p.transaction_id
    WHERE p.account = 'client_bank' AND t.occurred_on <= selected_as_of
      AND p.bank_account_id IN (SELECT i.bank_account_id FROM app.bank_statement_imports i WHERE i.id = ANY(selected_imports))
      AND NOT EXISTS (
        SELECT 1 FROM app.bank_statement_match_events m JOIN app.bank_statement_rows sr ON sr.id = m.statement_row_id
        JOIN app.bank_statement_imports si ON si.id = sr.statement_import_id
        WHERE m.kind = 'matched' AND m.finance_transaction_id = t.id
          AND sr.bank_account_id = p.bank_account_id AND si.period_end <= selected_as_of AND NOT EXISTS (
            SELECT 1 FROM app.bank_statement_match_events r WHERE r.kind = 'reversed' AND r.reversed_match_id = m.id))
  LOOP
    item_explanation := explanations ->> item.source_key;
    IF item_explanation IS NULL OR length(btrim(item_explanation)) NOT BETWEEN 1 AND 1000
      OR NOT app.is_safe_text(item_explanation) THEN
      RAISE EXCEPTION 'every outstanding item needs a safe explanation' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.client_account_reconciliation_items (
      reconciliation_id, kind, source_key, bank_account_id, occurred_on,
      amount_pence, reference, explanation
    ) VALUES (new_id, item.kind, item.source_key, item.bank_account_id, item.occurred_on,
      item.amount_pence, item.reference, item_explanation);
  END LOOP;
  IF bank_total <> cashbook_total THEN
    item_explanation := explanations ->> 'difference:bank-cashbook';
    IF item_explanation IS NULL OR length(btrim(item_explanation)) NOT BETWEEN 1 AND 1000
      OR NOT app.is_safe_text(item_explanation) THEN
      RAISE EXCEPTION 'the bank to cashbook difference needs a safe explanation' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.client_account_reconciliation_items (
      reconciliation_id, kind, source_key, amount_pence, explanation
    ) VALUES (new_id, 'difference', 'difference:bank-cashbook', bank_total - cashbook_total, item_explanation);
  END IF;
  IF cashbook_total <> client_total THEN
    item_explanation := explanations ->> 'difference:cashbook-client';
    IF item_explanation IS NULL OR length(btrim(item_explanation)) NOT BETWEEN 1 AND 1000
      OR NOT app.is_safe_text(item_explanation) THEN
      RAISE EXCEPTION 'the cashbook to client-ledger difference needs a safe explanation' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.client_account_reconciliation_items (
      reconciliation_id, kind, source_key, amount_pence, explanation
    ) VALUES (new_id, 'difference', 'difference:cashbook-client', cashbook_total - client_total, item_explanation);
  END IF;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION app.prepare_client_account_reconciliation(date, uuid[], jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_client_account_reconciliation(date, uuid[], jsonb, uuid) TO pms_app;

CREATE FUNCTION app.sign_off_client_account_reconciliation(
  target_reconciliation uuid, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected app.client_account_reconciliations%ROWTYPE; new_id uuid;
BEGIN
  PERFORM app.assert_active_compliance(actor_id);
  SELECT * INTO selected FROM app.client_account_reconciliations
    WHERE id = target_reconciliation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no reconciliation with this id' USING ERRCODE = 'no_data_found'; END IF;
  IF selected.prepared_by = actor_id THEN
    RAISE EXCEPTION 'the preparer cannot sign off their own reconciliation'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.client_account_reconciliation_sign_offs (
    reconciliation_id, signed_off_by
  ) VALUES (target_reconciliation, actor_id) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION app.sign_off_client_account_reconciliation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sign_off_client_account_reconciliation(uuid, uuid) TO pms_app;

CREATE FUNCTION app.refuse_reconciliation_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'statement and reconciliation records cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_reconciliation_edit() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'bank_statement_imports', 'bank_statement_rows', 'bank_statement_match_events',
    'client_account_reconciliations', 'client_account_reconciliation_statements',
    'client_account_reconciliation_items', 'client_account_reconciliation_sign_offs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_reconciliation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_reconciliation_edit()', table_name, table_name);
  END LOOP;
END;
$$;
