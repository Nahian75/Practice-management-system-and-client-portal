-- Finance 14c: encrypted bank register, balanced postings, receipts and allocation corrections.
CREATE TABLE app.bank_accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,
  name text NOT NULL,
  last_four text NOT NULL,
  encryption_context uuid NOT NULL UNIQUE,
  fingerprint bytea NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  opened_on date NOT NULL,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bank_accounts_kind_valid CHECK (kind IN ('client', 'business')),
  CONSTRAINT bank_accounts_name_valid CHECK (
    length(btrim(name)) BETWEEN 1 AND 200 AND app.is_safe_text(name)
  ),
  CONSTRAINT bank_accounts_last_four_valid CHECK (last_four ~ '^[0-9]{4}$'),
  CONSTRAINT bank_accounts_fingerprint_valid CHECK (octet_length(fingerprint) = 32),
  CONSTRAINT bank_accounts_key_version_valid CHECK (key_version BETWEEN 1 AND 32767),
  CONSTRAINT bank_accounts_nonce_valid CHECK (octet_length(nonce) = 12),
  CONSTRAINT bank_accounts_ciphertext_valid CHECK (octet_length(ciphertext) BETWEEN 1 AND 500),
  CONSTRAINT bank_accounts_tag_valid CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT bank_accounts_opened_on_valid CHECK (opened_on >= DATE '1900-01-01')
);

CREATE INDEX bank_accounts_kind_idx ON app.bank_accounts (kind, id);

CREATE TABLE app.bank_account_closures (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  bank_account_id uuid NOT NULL UNIQUE REFERENCES app.bank_accounts(id),
  closed_on date NOT NULL,
  reason text NOT NULL,
  closed_by uuid NOT NULL REFERENCES app.accounts(id),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bank_account_closures_date_valid CHECK (closed_on >= DATE '1900-01-01'),
  CONSTRAINT bank_account_closures_reason_valid CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500 AND app.is_safe_text(reason)
  )
);

CREATE TABLE app.finance_transactions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  matter_id uuid NOT NULL REFERENCES app.matters(id),
  related_matter_id uuid REFERENCES app.matters(id),
  bank_account_id uuid REFERENCES app.bank_accounts(id),
  source_bill_id uuid UNIQUE REFERENCES app.issued_bills(id),
  source_credit_note_id uuid UNIQUE REFERENCES app.credit_notes(id),
  reference text,
  purpose text NOT NULL,
  amount_pence bigint NOT NULL,
  occurred_on date NOT NULL,
  posted_by uuid NOT NULL REFERENCES app.accounts(id),
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_transactions_kind_valid CHECK (kind IN (
    'bill', 'credit_note', 'client_receipt', 'business_receipt',
    'client_allocation', 'business_allocation'
  )),
  CONSTRAINT finance_transactions_reference_valid CHECK (
    reference IS NULL OR (length(btrim(reference)) BETWEEN 1 AND 100 AND app.is_safe_text(reference))
  ),
  CONSTRAINT finance_transactions_purpose_valid CHECK (
    length(btrim(purpose)) BETWEEN 1 AND 500 AND app.is_safe_text(purpose)
  ),
  CONSTRAINT finance_transactions_amount_valid CHECK (amount_pence BETWEEN 1 AND 100000000),
  CONSTRAINT finance_transactions_date_valid CHECK (occurred_on >= DATE '1900-01-01'),
  CONSTRAINT finance_transactions_shape_valid CHECK (
    (kind = 'bill' AND bank_account_id IS NULL AND related_matter_id IS NULL
      AND source_bill_id IS NOT NULL AND source_credit_note_id IS NULL AND reference IS NOT NULL)
    OR
    (kind = 'credit_note' AND bank_account_id IS NULL AND related_matter_id IS NULL
      AND source_bill_id IS NULL AND source_credit_note_id IS NOT NULL AND reference IS NOT NULL)
    OR
    (kind IN ('client_receipt', 'business_receipt') AND bank_account_id IS NOT NULL
      AND related_matter_id IS NULL AND source_bill_id IS NULL AND source_credit_note_id IS NULL
      AND reference IS NOT NULL)
    OR
    (kind IN ('client_allocation', 'business_allocation') AND bank_account_id IS NULL
      AND related_matter_id IS NOT NULL AND related_matter_id <> matter_id
      AND source_bill_id IS NULL AND source_credit_note_id IS NULL AND reference IS NULL)
  )
);

CREATE UNIQUE INDEX finance_receipt_reference_unique
  ON app.finance_transactions (bank_account_id, reference)
  WHERE kind IN ('client_receipt', 'business_receipt');
CREATE INDEX finance_transactions_matter_idx ON app.finance_transactions (matter_id, id DESC);
CREATE INDEX finance_transactions_related_matter_idx
  ON app.finance_transactions (related_matter_id, id DESC) WHERE related_matter_id IS NOT NULL;
CREATE INDEX finance_transactions_bank_idx
  ON app.finance_transactions (bank_account_id, id DESC) WHERE bank_account_id IS NOT NULL;

CREATE TABLE app.finance_postings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  transaction_id uuid NOT NULL REFERENCES app.finance_transactions(id),
  position smallint NOT NULL,
  account text NOT NULL,
  direction text NOT NULL,
  amount_pence bigint NOT NULL,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  matter_id uuid NOT NULL REFERENCES app.matters(id),
  bank_account_id uuid REFERENCES app.bank_accounts(id),
  CONSTRAINT finance_postings_position_valid CHECK (position BETWEEN 1 AND 4),
  CONSTRAINT finance_postings_account_valid CHECK (account IN (
    'client_bank', 'business_bank', 'client_ledger', 'business_ledger', 'business_control'
  )),
  CONSTRAINT finance_postings_direction_valid CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT finance_postings_amount_valid CHECK (amount_pence BETWEEN 1 AND 100000000),
  CONSTRAINT finance_postings_bank_shape CHECK (
    (account IN ('client_bank', 'business_bank') AND bank_account_id IS NOT NULL)
    OR (account NOT IN ('client_bank', 'business_bank') AND bank_account_id IS NULL)
  ),
  CONSTRAINT finance_postings_position_unique UNIQUE (transaction_id, position)
);

CREATE INDEX finance_postings_matter_page_idx
  ON app.finance_postings (matter_id, id DESC)
  WHERE account IN ('client_ledger', 'business_ledger');
CREATE INDEX finance_postings_bank_page_idx
  ON app.finance_postings (bank_account_id, id DESC)
  WHERE bank_account_id IS NOT NULL;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.bank_accounts, app.bank_account_closures, app.finance_transactions, app.finance_postings
  FROM pms_app;

CREATE FUNCTION app.create_bank_account(
  selected_kind text, selected_name text, selected_last_four text,
  selected_context uuid, selected_fingerprint bytea, selected_key_version smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_auth_tag bytea,
  selected_opened_on date, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  IF selected_opened_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'a bank account cannot open in the future' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_accounts (
    kind, name, last_four, encryption_context, fingerprint, key_version, nonce,
    ciphertext, auth_tag, opened_on, created_by
  ) VALUES (
    selected_kind, selected_name, selected_last_four, selected_context, selected_fingerprint,
    selected_key_version, selected_nonce, selected_ciphertext, selected_auth_tag,
    selected_opened_on, actor_id
  ) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_bank_account(
  text, text, text, uuid, bytea, smallint, bytea, bytea, bytea, date, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_bank_account(
  text, text, text, uuid, bytea, smallint, bytea, bytea, bytea, date, uuid
) TO pms_app;

CREATE FUNCTION app.close_bank_account(
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no bank account with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM app.bank_account_closures c WHERE c.bank_account_id = target_account) THEN
    RAISE EXCEPTION 'this bank account is already closed' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_closed_on < selected_account.opened_on
    OR selected_closed_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date
  THEN
    RAISE EXCEPTION 'the bank account closure date is not valid' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bank_account_closures (bank_account_id, closed_on, reason, closed_by)
  VALUES (target_account, selected_closed_on, selected_reason, actor_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.close_bank_account(uuid, date, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.close_bank_account(uuid, date, text, uuid) TO pms_app;

CREATE FUNCTION app.validate_finance_transaction() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  target_transaction uuid;
  selected app.finance_transactions%ROWTYPE;
  posting_count integer;
  debit_total numeric;
  credit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'finance_transactions' THEN
    target_transaction := NEW.id;
  ELSE
    target_transaction := NEW.transaction_id;
  END IF;
  SELECT * INTO selected FROM app.finance_transactions WHERE id = target_transaction;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a posting requires its transaction' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), coalesce(sum(amount_pence) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount_pence) FILTER (WHERE direction = 'credit'), 0)
  INTO posting_count, debit_total, credit_total
  FROM app.finance_postings WHERE transaction_id = target_transaction;
  IF posting_count <> 2 OR debit_total <> selected.amount_pence OR credit_total <> selected.amount_pence THEN
    RAISE EXCEPTION 'a finance transaction must have two balanced postings'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.finance_postings p
    WHERE p.transaction_id = target_transaction
      AND (p.amount_pence <> selected.amount_pence OR p.client_id <> selected.client_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM app.matters m
    WHERE m.id = selected.matter_id AND m.client_id = selected.client_id
  ) OR (selected.related_matter_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.matters m
    WHERE m.id = selected.related_matter_id AND m.client_id = selected.client_id
  )) OR EXISTS (
    SELECT 1 FROM app.finance_postings p
    JOIN app.matters m ON m.id = p.matter_id
    WHERE p.transaction_id = target_transaction AND m.client_id <> selected.client_id
  ) THEN
    RAISE EXCEPTION 'finance transaction client and matter links do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  IF selected.kind = 'bill' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.issued_bills b
      WHERE b.id = selected.source_bill_id AND b.client_id = selected.client_id
        AND b.matter_id = selected.matter_id AND b.gross_pence = selected.amount_pence
    ) OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = 'business_ledger' AND p.direction = 'debit'
          AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = 'business_control' AND p.direction = 'credit'
          AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
    THEN
      RAISE EXCEPTION 'bill postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind = 'credit_note' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.credit_notes c JOIN app.issued_bills b ON b.id = c.bill_id
      WHERE c.id = selected.source_credit_note_id AND b.client_id = selected.client_id
        AND b.matter_id = selected.matter_id AND c.gross_pence = selected.amount_pence
    ) OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = 'business_control' AND p.direction = 'debit'
          AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = 'business_ledger' AND p.direction = 'credit'
          AND p.matter_id = selected.matter_id AND p.bank_account_id IS NULL) <> 1
    THEN
      RAISE EXCEPTION 'credit note postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF selected.kind IN ('client_receipt', 'business_receipt') THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.bank_accounts b
      WHERE b.id = selected.bank_account_id
        AND b.kind = CASE selected.kind WHEN 'client_receipt' THEN 'client' ELSE 'business' END
    ) OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = CASE selected.kind WHEN 'client_receipt' THEN 'client_bank' ELSE 'business_bank' END
          AND p.direction = 'debit' AND p.matter_id = selected.matter_id
          AND p.bank_account_id = selected.bank_account_id) <> 1
      OR (SELECT count(*) FROM app.finance_postings p WHERE p.transaction_id = target_transaction
          AND p.account = CASE selected.kind WHEN 'client_receipt' THEN 'client_ledger' ELSE 'business_ledger' END
          AND p.direction = 'credit' AND p.matter_id = selected.matter_id
          AND p.bank_account_id IS NULL) <> 1
    THEN
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
          AND p.bank_account_id IS NULL) <> 1
    THEN
      RAISE EXCEPTION 'allocation postings are not valid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_finance_transaction() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER finance_transactions_balanced
  AFTER INSERT ON app.finance_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.validate_finance_transaction();
CREATE CONSTRAINT TRIGGER finance_postings_balanced
  AFTER INSERT ON app.finance_postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.validate_finance_transaction();

CREATE FUNCTION app.require_nonnegative_client_balance() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  balance numeric;
BEGIN
  IF NEW.account <> 'client_ledger' THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_pence ELSE -amount_pence END), 0)
  INTO balance FROM app.finance_postings
  WHERE account = 'client_ledger' AND matter_id = NEW.matter_id;
  IF balance < 0 THEN
    RAISE EXCEPTION 'a matter client ledger cannot become negative' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.require_nonnegative_client_balance() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER finance_client_balance_nonnegative
  AFTER INSERT ON app.finance_postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.require_nonnegative_client_balance();

CREATE FUNCTION app.record_finance_receipt(
  target_bank uuid, target_matter uuid, selected_date date, selected_amount bigint,
  selected_reference text, selected_purpose text, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_bank app.bank_accounts%ROWTYPE;
  selected_client uuid;
  new_transaction uuid;
  selected_kind text;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO selected_bank FROM app.bank_accounts WHERE id = target_bank FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no bank account with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF selected_date > (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    OR selected_date < selected_bank.opened_on
    OR EXISTS (
      SELECT 1 FROM app.bank_account_closures c
      WHERE c.bank_account_id = target_bank AND selected_date > c.closed_on
    )
  THEN
    RAISE EXCEPTION 'the receipt date is outside the bank account history'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT client_id INTO selected_client FROM app.matters
  WHERE id = target_matter AND status IN ('open', 'closed') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a receipt requires an open or closed matter' USING ERRCODE = 'no_data_found';
  END IF;
  selected_kind := CASE selected_bank.kind WHEN 'client' THEN 'client_receipt' ELSE 'business_receipt' END;
  INSERT INTO app.finance_transactions (
    kind, client_id, matter_id, bank_account_id, reference, purpose,
    amount_pence, occurred_on, posted_by
  ) VALUES (
    selected_kind, selected_client, target_matter, target_bank, selected_reference,
    selected_purpose, selected_amount, selected_date, actor_id
  ) RETURNING id INTO new_transaction;
  INSERT INTO app.finance_postings (
    transaction_id, position, account, direction, amount_pence,
    client_id, matter_id, bank_account_id
  ) VALUES
    (new_transaction, 1,
      CASE selected_bank.kind WHEN 'client' THEN 'client_bank' ELSE 'business_bank' END,
      'debit', selected_amount, selected_client, target_matter, target_bank),
    (new_transaction, 2,
      CASE selected_bank.kind WHEN 'client' THEN 'client_ledger' ELSE 'business_ledger' END,
      'credit', selected_amount, selected_client, target_matter, NULL);
  RETURN new_transaction;
END;
$$;

REVOKE ALL ON FUNCTION app.record_finance_receipt(uuid, uuid, date, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_finance_receipt(uuid, uuid, date, bigint, text, text, uuid) TO pms_app;

CREATE FUNCTION app.record_finance_allocation(
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
    IF available < selected_amount THEN
      RAISE EXCEPTION 'the source matter has insufficient client money'
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

REVOKE ALL ON FUNCTION app.record_finance_allocation(text, uuid, uuid, bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_finance_allocation(text, uuid, uuid, bigint, text, uuid) TO pms_app;

CREATE FUNCTION app.post_issued_bill() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  new_transaction uuid;
BEGIN
  INSERT INTO app.finance_transactions (
    kind, client_id, matter_id, source_bill_id, reference, purpose,
    amount_pence, occurred_on, posted_by, posted_at
  ) VALUES (
    'bill', NEW.client_id, NEW.matter_id, NEW.id, NEW.reference,
    'Issued bill ' || NEW.reference, NEW.gross_pence, NEW.issued_on, NEW.issued_by, NEW.issued_at
  ) RETURNING id INTO new_transaction;
  INSERT INTO app.finance_postings (
    transaction_id, position, account, direction, amount_pence, client_id, matter_id
  ) VALUES
    (new_transaction, 1, 'business_ledger', 'debit', NEW.gross_pence, NEW.client_id, NEW.matter_id),
    (new_transaction, 2, 'business_control', 'credit', NEW.gross_pence, NEW.client_id, NEW.matter_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.post_issued_bill() FROM PUBLIC;

CREATE FUNCTION app.post_credit_note() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  source_bill app.issued_bills%ROWTYPE;
  new_transaction uuid;
BEGIN
  SELECT * INTO source_bill FROM app.issued_bills WHERE id = NEW.bill_id;
  INSERT INTO app.finance_transactions (
    kind, client_id, matter_id, source_credit_note_id, reference, purpose,
    amount_pence, occurred_on, posted_by, posted_at
  ) VALUES (
    'credit_note', source_bill.client_id, source_bill.matter_id, NEW.id, NEW.reference,
    'Credit note ' || NEW.reference, NEW.gross_pence, NEW.issued_on, NEW.issued_by, NEW.issued_at
  ) RETURNING id INTO new_transaction;
  INSERT INTO app.finance_postings (
    transaction_id, position, account, direction, amount_pence, client_id, matter_id
  ) VALUES
    (new_transaction, 1, 'business_control', 'debit', NEW.gross_pence, source_bill.client_id, source_bill.matter_id),
    (new_transaction, 2, 'business_ledger', 'credit', NEW.gross_pence, source_bill.client_id, source_bill.matter_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.post_credit_note() FROM PUBLIC;

CREATE TRIGGER issued_bill_posts_to_ledger
  AFTER INSERT ON app.issued_bills FOR EACH ROW EXECUTE FUNCTION app.post_issued_bill();
CREATE TRIGGER credit_note_posts_to_ledger
  AFTER INSERT ON app.credit_notes FOR EACH ROW EXECUTE FUNCTION app.post_credit_note();

-- Existing step 14b records, if any, receive the same fixed postings.
DO $$
DECLARE
  bill app.issued_bills%ROWTYPE;
  credit app.credit_notes%ROWTYPE;
  source_bill app.issued_bills%ROWTYPE;
  new_transaction uuid;
BEGIN
  FOR bill IN SELECT * FROM app.issued_bills ORDER BY number LOOP
    INSERT INTO app.finance_transactions (
      kind, client_id, matter_id, source_bill_id, reference, purpose,
      amount_pence, occurred_on, posted_by, posted_at
    ) VALUES (
      'bill', bill.client_id, bill.matter_id, bill.id, bill.reference,
      'Issued bill ' || bill.reference, bill.gross_pence, bill.issued_on, bill.issued_by, bill.issued_at
    ) RETURNING id INTO new_transaction;
    INSERT INTO app.finance_postings (
      transaction_id, position, account, direction, amount_pence, client_id, matter_id
    ) VALUES
      (new_transaction, 1, 'business_ledger', 'debit', bill.gross_pence, bill.client_id, bill.matter_id),
      (new_transaction, 2, 'business_control', 'credit', bill.gross_pence, bill.client_id, bill.matter_id);
  END LOOP;
  FOR credit IN SELECT * FROM app.credit_notes ORDER BY number LOOP
    SELECT * INTO source_bill FROM app.issued_bills WHERE id = credit.bill_id;
    INSERT INTO app.finance_transactions (
      kind, client_id, matter_id, source_credit_note_id, reference, purpose,
      amount_pence, occurred_on, posted_by, posted_at
    ) VALUES (
      'credit_note', source_bill.client_id, source_bill.matter_id, credit.id, credit.reference,
      'Credit note ' || credit.reference, credit.gross_pence, credit.issued_on,
      credit.issued_by, credit.issued_at
    ) RETURNING id INTO new_transaction;
    INSERT INTO app.finance_postings (
      transaction_id, position, account, direction, amount_pence, client_id, matter_id
    ) VALUES
      (new_transaction, 1, 'business_control', 'debit', credit.gross_pence,
        source_bill.client_id, source_bill.matter_id),
      (new_transaction, 2, 'business_ledger', 'credit', credit.gross_pence,
        source_bill.client_id, source_bill.matter_id);
  END LOOP;
END;
$$;

CREATE FUNCTION app.refuse_finance_ledger_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance ledger records cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_finance_ledger_edit() FROM PUBLIC;

CREATE TRIGGER bank_accounts_fixed BEFORE UPDATE OR DELETE ON app.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER bank_account_closures_fixed BEFORE UPDATE OR DELETE ON app.bank_account_closures
  FOR EACH ROW EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER finance_transactions_fixed BEFORE UPDATE OR DELETE ON app.finance_transactions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER finance_postings_fixed BEFORE UPDATE OR DELETE ON app.finance_postings
  FOR EACH ROW EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER bank_accounts_no_truncate BEFORE TRUNCATE ON app.bank_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER bank_account_closures_no_truncate BEFORE TRUNCATE ON app.bank_account_closures
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER finance_transactions_no_truncate BEFORE TRUNCATE ON app.finance_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_finance_ledger_edit();
CREATE TRIGGER finance_postings_no_truncate BEFORE TRUNCATE ON app.finance_postings
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_finance_ledger_edit();
