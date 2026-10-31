-- Immutable expense records; monetary postings still use the existing ledger.
CREATE TABLE app.matter_expenses (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  matter_id uuid NOT NULL REFERENCES app.matters(id),
  incurred_on date NOT NULL CHECK (incurred_on >= DATE '1900-01-01'),
  kind text NOT NULL CHECK (kind IN ('recharge','disbursement')),
  description text NOT NULL CHECK (app.is_safe_text(description) AND length(btrim(description)) BETWEEN 1 AND 1000),
  net_pence bigint NOT NULL CHECK (net_pence BETWEEN 1 AND 100000000),
  vat_treatment text NOT NULL CHECK (vat_treatment IN ('standard','reduced','zero','exempt','outside_scope')),
  billable boolean NOT NULL,
  receipt_version_id uuid REFERENCES app.document_versions(id),
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid NOT NULL,
  UNIQUE(recorded_by,request_id)
);
CREATE INDEX matter_expenses_matter_page ON app.matter_expenses(matter_id,id DESC);
CREATE TABLE app.matter_expense_voids (
  expense_id uuid PRIMARY KEY REFERENCES app.matter_expenses(id),
  reason text NOT NULL CHECK (app.is_safe_text(reason) AND length(btrim(reason)) BETWEEN 1 AND 500),
  voided_by uuid NOT NULL REFERENCES app.accounts(id),
  voided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON app.matter_expenses,app.matter_expense_voids FROM pms_app;
GRANT SELECT ON app.matter_expenses,app.matter_expense_voids TO pms_app;
CREATE TRIGGER matter_expenses_fixed BEFORE UPDATE OR DELETE ON app.matter_expenses
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER matter_expenses_no_truncate BEFORE TRUNCATE ON app.matter_expenses
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER matter_expense_voids_fixed BEFORE UPDATE OR DELETE ON app.matter_expense_voids
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER matter_expense_voids_no_truncate BEFORE TRUNCATE ON app.matter_expense_voids
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();

CREATE FUNCTION app.assert_expense_actor(actor_id uuid,target_matter uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts WHERE id=actor_id AND kind='staff' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM 1 FROM app.account_roles WHERE account_id=actor_id AND role='accounts' AND revoked_at IS NULL FOR SHARE;
  IF FOUND THEN RETURN; END IF;
  PERFORM 1 FROM app.account_roles r JOIN app.matter_team t ON t.account_id=r.account_id
    WHERE r.account_id=actor_id AND r.role IN ('partner','fee_earner') AND r.revoked_at IS NULL
      AND t.matter_id=target_matter AND t.removed_at IS NULL FOR SHARE OF r,t;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_expense_actor(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.record_matter_expense(target_matter uuid,selected_date date,selected_kind text,
  selected_description text,selected_net bigint,selected_vat text,selected_billable boolean,
  selected_receipt uuid,selected_request uuid,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing app.matter_expenses%ROWTYPE; created_id uuid;
BEGIN
  PERFORM 1 FROM app.matters WHERE id=target_matter FOR SHARE;
  IF NOT FOUND THEN RAISE no_data_found; END IF;
  PERFORM app.assert_expense_actor(actor_id,target_matter);
  PERFORM pg_advisory_xact_lock(hashtextextended('expense-request:'||actor_id::text||':'||selected_request::text,0));
  SELECT * INTO existing FROM app.matter_expenses WHERE recorded_by=actor_id AND request_id=selected_request;
  IF FOUND THEN
    IF ROW(existing.matter_id,existing.incurred_on,existing.kind,existing.description,existing.net_pence,
      existing.vat_treatment,existing.billable,existing.receipt_version_id)
      IS DISTINCT FROM ROW(target_matter,selected_date,selected_kind,selected_description,selected_net,
      selected_vat,selected_billable,selected_receipt) THEN
      RAISE EXCEPTION 'request already used for different expense details' USING ERRCODE='check_violation';
    END IF;
    RETURN existing.id;
  END IF;
  PERFORM 1 FROM app.matters WHERE id=target_matter AND status='open';
  IF NOT FOUND OR selected_date>app.london_today() THEN
    RAISE EXCEPTION 'expense requires an open matter and a nonfuture date' USING ERRCODE='check_violation';
  END IF;
  PERFORM app.assert_aml_gate(target_matter,'billing');
  IF selected_receipt IS NOT NULL THEN
    PERFORM 1 FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id
      WHERE v.id=selected_receipt AND d.matter_id=target_matter
        AND NOT EXISTS(SELECT 1 FROM app.document_withdrawals w WHERE w.document_id=d.id)
      FOR SHARE OF d;
    IF NOT FOUND THEN RAISE EXCEPTION 'receipt is unavailable for this matter' USING ERRCODE='check_violation'; END IF;
  END IF;
  INSERT INTO app.matter_expenses(matter_id,incurred_on,kind,description,net_pence,vat_treatment,
    billable,receipt_version_id,request_id,recorded_by)
    VALUES(target_matter,selected_date,selected_kind,selected_description,selected_net,selected_vat,
      selected_billable,selected_receipt,selected_request,actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_matter_expense(uuid,date,text,text,bigint,text,boolean,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_matter_expense(uuid,date,text,text,bigint,text,boolean,uuid,uuid,uuid) TO pms_app;

ALTER TABLE app.bill_draft_lines ADD COLUMN expense_entry_id uuid REFERENCES app.matter_expenses(id);
ALTER TABLE app.issued_bill_lines ADD COLUMN source_expense_entry_id uuid REFERENCES app.matter_expenses(id);
ALTER TABLE app.bill_draft_lines ADD CONSTRAINT bill_draft_lines_expense_unique UNIQUE(draft_id,expense_entry_id);
ALTER TABLE app.issued_bill_lines ADD CONSTRAINT issued_bill_lines_expense_unique UNIQUE(source_expense_entry_id);
-- NULL time references are legitimate on multiple manual/expense lines.
ALTER TABLE app.bill_draft_lines DROP CONSTRAINT bill_draft_lines_time_unique;
ALTER TABLE app.bill_draft_lines ADD CONSTRAINT bill_draft_lines_time_unique UNIQUE(draft_id,time_entry_id);

CREATE FUNCTION app.void_matter_expense(target_expense uuid,selected_reason text,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target app.matter_expenses%ROWTYPE; target_matter uuid;
BEGIN
  SELECT matter_id INTO target_matter FROM app.matter_expenses WHERE id=target_expense;
  IF NOT FOUND THEN RAISE no_data_found; END IF;
  PERFORM 1 FROM app.matters WHERE id=target_matter AND status='open' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense void requires an open matter' USING ERRCODE='check_violation'; END IF;
  PERFORM app.assert_expense_actor(actor_id,target_matter);
  SELECT * INTO target FROM app.matter_expenses WHERE id=target_expense FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app.issued_bill_lines WHERE source_expense_entry_id=target_expense) THEN
    RAISE EXCEPTION 'billed expenses require a credit note' USING ERRCODE='check_violation';
  END IF;
  INSERT INTO app.matter_expense_voids(expense_id,reason,voided_by) VALUES(target_expense,selected_reason,actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.void_matter_expense(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.void_matter_expense(uuid,text,uuid) TO pms_app;

CREATE OR REPLACE FUNCTION app.validate_bill_supplier_and_lines(supplier jsonb,lines jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE line jsonb;
BEGIN
  IF jsonb_typeof(supplier) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(supplier) key)
      IS DISTINCT FROM ARRAY['address_line1','address_line2','country','name','postcode','town','vat_registration_number']::text[] THEN
    RAISE EXCEPTION 'supplier fields are not valid' USING ERRCODE='check_violation';
  END IF;
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'a bill needs between 1 and 100 lines' USING ERRCODE='check_violation';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(line-'expense_entry_id') key)
        IS DISTINCT FROM ARRAY['description','kind','net_pence','time_entry_id','vat_treatment']::text[] THEN
      RAISE EXCEPTION 'bill line fields are not valid' USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) item WHERE item->>'vat_treatment' IN ('standard','reduced','zero'))
    AND nullif(btrim(supplier->>'vat_registration_number'),'') IS NULL THEN
    RAISE EXCEPTION 'taxable lines require the supplier VAT registration number' USING ERRCODE='check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.store_bill_draft_lines(target_draft uuid,target_matter uuid,lines jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE line jsonb; line_number integer:=0; selected_time uuid; selected_expense uuid; expense app.matter_expenses%ROWTYPE;
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    line_number:=line_number+1;
    selected_time:=nullif(line->>'time_entry_id','')::uuid;
    selected_expense:=nullif(line->>'expense_entry_id','')::uuid;
    IF selected_time IS NOT NULL THEN
      IF line->>'kind'<>'fee' OR selected_expense IS NOT NULL THEN
        RAISE EXCEPTION 'time is linked only to a fee line' USING ERRCODE='check_violation';
      END IF;
      PERFORM 1 FROM app.time_entries t WHERE t.id=selected_time AND t.matter_id=target_matter AND NOT t.voided FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'time entry unavailable' USING ERRCODE='check_violation'; END IF;
    END IF;
    IF selected_expense IS NOT NULL THEN
      SELECT * INTO expense FROM app.matter_expenses WHERE id=selected_expense AND matter_id=target_matter FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'expense unavailable' USING ERRCODE='check_violation'; END IF;
      IF NOT expense.billable OR EXISTS(SELECT 1 FROM app.matter_expense_voids WHERE expense_id=selected_expense)
        OR EXISTS(SELECT 1 FROM app.issued_bill_lines WHERE source_expense_entry_id=selected_expense)
        OR ROW(expense.kind,expense.description,expense.net_pence,expense.vat_treatment)
          IS DISTINCT FROM ROW(line->>'kind',line->>'description',(line->>'net_pence')::bigint,line->>'vat_treatment') THEN
        RAISE EXCEPTION 'expense is not billable or its details differ' USING ERRCODE='check_violation';
      END IF;
    END IF;
    INSERT INTO app.bill_draft_lines(draft_id,position,kind,description,net_pence,vat_treatment,time_entry_id,expense_entry_id)
      VALUES(target_draft,line_number,line->>'kind',line->>'description',(line->>'net_pence')::bigint,
        line->>'vat_treatment',selected_time,selected_expense);
  END LOOP;
END;
$$;

-- Issue uses the existing immutable invoice path. Capture the source by draft
-- position before inserting each issued line, while locking its expense.
CREATE FUNCTION app.bind_issued_expense() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE selected_expense uuid; expense app.matter_expenses%ROWTYPE; target_matter uuid;
BEGIN
  SELECT d.expense_entry_id,b.matter_id INTO selected_expense,target_matter FROM app.issued_bills b
    JOIN app.bill_draft_lines d ON d.draft_id=b.draft_id AND d.position=NEW.position WHERE b.id=NEW.bill_id;
  NEW.source_expense_entry_id:=selected_expense;
  IF selected_expense IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO expense FROM app.matter_expenses WHERE id=selected_expense FOR UPDATE;
  IF NOT FOUND OR expense.matter_id<>target_matter OR NOT expense.billable
    OR EXISTS(SELECT 1 FROM app.matter_expense_voids WHERE expense_id=selected_expense)
    OR NEW.source_time_entry_id IS NOT NULL
    OR ROW(expense.kind,expense.description,expense.net_pence,expense.vat_treatment)
      IS DISTINCT FROM ROW(NEW.kind,NEW.description,NEW.net_pence,NEW.vat_treatment) THEN
    RAISE EXCEPTION 'expense is no longer available for billing' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.bind_issued_expense() FROM PUBLIC;
CREATE TRIGGER issued_bill_expense_binding BEFORE INSERT ON app.issued_bill_lines
  FOR EACH ROW EXECUTE FUNCTION app.bind_issued_expense();
