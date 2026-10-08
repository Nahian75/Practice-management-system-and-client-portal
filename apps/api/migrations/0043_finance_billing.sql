-- Finance step 14b: draft bills, fixed issue snapshots, credit notes and delivery records.
CREATE TABLE app.bill_drafts (
  id                           uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id                    uuid        NOT NULL REFERENCES app.matters (id),
  tax_point                    date        NOT NULL,
  due_on                       date        NOT NULL,
  supplier_name                text        NOT NULL,
  supplier_address_line1       text        NOT NULL,
  supplier_address_line2       text,
  supplier_town                text        NOT NULL,
  supplier_postcode            text,
  supplier_country             text        NOT NULL,
  supplier_vat_registration_number text,
  created_by                   uuid        NOT NULL REFERENCES app.accounts (id),
  created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by                   uuid        NOT NULL REFERENCES app.accounts (id),
  updated_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT bill_drafts_dates_valid CHECK (
    tax_point BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'
    AND due_on BETWEEN tax_point AND DATE '9999-12-31'
  ),
  CONSTRAINT bill_drafts_supplier_name_valid CHECK (
    length(btrim(supplier_name)) BETWEEN 1 AND 200 AND app.is_safe_text(supplier_name)
  ),
  CONSTRAINT bill_drafts_supplier_address1_valid CHECK (
    length(btrim(supplier_address_line1)) BETWEEN 1 AND 200 AND app.is_safe_text(supplier_address_line1)
  ),
  CONSTRAINT bill_drafts_supplier_address2_valid CHECK (
    supplier_address_line2 IS NULL OR
    (length(btrim(supplier_address_line2)) BETWEEN 1 AND 200 AND app.is_safe_text(supplier_address_line2))
  ),
  CONSTRAINT bill_drafts_supplier_town_valid CHECK (
    length(btrim(supplier_town)) BETWEEN 1 AND 100 AND app.is_safe_text(supplier_town)
  ),
  CONSTRAINT bill_drafts_supplier_postcode_valid CHECK (
    supplier_postcode IS NULL OR
    (length(btrim(supplier_postcode)) BETWEEN 1 AND 16 AND app.is_safe_text(supplier_postcode))
  ),
  CONSTRAINT bill_drafts_supplier_country_valid CHECK (supplier_country ~ '^[A-Z]{2}$'),
  CONSTRAINT bill_drafts_supplier_vat_valid CHECK (
    supplier_vat_registration_number IS NULL OR
    (length(btrim(supplier_vat_registration_number)) BETWEEN 2 AND 30
      AND supplier_vat_registration_number ~ '^[A-Z0-9 ]+$')
  )
);

CREATE INDEX bill_drafts_matter_idx ON app.bill_drafts (matter_id, id DESC);

CREATE TABLE app.bill_draft_lines (
  id             uuid    PRIMARY KEY DEFAULT uuidv7(),
  draft_id       uuid    NOT NULL REFERENCES app.bill_drafts (id),
  position       integer NOT NULL,
  kind           text    NOT NULL,
  description    text    NOT NULL,
  net_pence      bigint  NOT NULL,
  vat_treatment  text    NOT NULL,
  time_entry_id  uuid    REFERENCES app.time_entries (id),

  CONSTRAINT bill_draft_lines_position_valid CHECK (position BETWEEN 1 AND 100),
  CONSTRAINT bill_draft_lines_kind_valid CHECK (kind IN ('fee', 'recharge', 'disbursement')),
  CONSTRAINT bill_draft_lines_description_valid CHECK (
    length(btrim(description)) BETWEEN 1 AND 1000 AND app.is_safe_text(description)
  ),
  CONSTRAINT bill_draft_lines_net_valid CHECK (net_pence BETWEEN 1 AND 100000000),
  CONSTRAINT bill_draft_lines_vat_valid CHECK (
    vat_treatment IN ('standard', 'reduced', 'zero', 'exempt', 'outside_scope')
  ),
  CONSTRAINT bill_draft_lines_time_kind CHECK (time_entry_id IS NULL OR kind = 'fee'),
  CONSTRAINT bill_draft_lines_position_unique UNIQUE (draft_id, position),
  CONSTRAINT bill_draft_lines_time_unique UNIQUE NULLS NOT DISTINCT (draft_id, time_entry_id)
);

CREATE INDEX bill_draft_lines_draft_idx ON app.bill_draft_lines (draft_id, position);

CREATE TABLE app.issued_bills (
  id                           uuid        PRIMARY KEY DEFAULT uuidv7(),
  draft_id                     uuid        NOT NULL UNIQUE REFERENCES app.bill_drafts (id),
  number                       bigint      NOT NULL,
  reference                    text        GENERATED ALWAYS AS
    ('INV-' || lpad(number::text, greatest(6, length(number::text)), '0')) STORED,
  matter_id                    uuid        NOT NULL REFERENCES app.matters (id),
  client_id                    uuid        NOT NULL REFERENCES app.clients (id),
  matter_reference             text        NOT NULL,
  client_reference             text        NOT NULL,
  client_name                  text        NOT NULL,
  client_address_line1         text        NOT NULL,
  client_address_line2         text,
  client_town                  text        NOT NULL,
  client_postcode              text,
  client_country               text        NOT NULL,
  supplier_name                text        NOT NULL,
  supplier_address_line1       text        NOT NULL,
  supplier_address_line2       text,
  supplier_town                text        NOT NULL,
  supplier_postcode            text,
  supplier_country             text        NOT NULL,
  supplier_vat_registration_number text,
  tax_point                    date        NOT NULL,
  due_on                       date        NOT NULL,
  net_pence                    bigint      NOT NULL,
  vat_pence                    bigint      NOT NULL,
  gross_pence                  bigint      NOT NULL,
  issued_by                    uuid        NOT NULL REFERENCES app.accounts (id),
  issued_on                    date        NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'Europe/London')::date),
  issued_at                    timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT issued_bills_number_positive CHECK (number > 0),
  CONSTRAINT issued_bills_totals_valid CHECK (
    net_pence > 0 AND vat_pence >= 0 AND gross_pence = net_pence + vat_pence
  ),
  CONSTRAINT issued_bills_number_unique UNIQUE (number),
  CONSTRAINT issued_bills_reference_unique UNIQUE (reference)
);

CREATE INDEX issued_bills_matter_idx ON app.issued_bills (matter_id, number DESC);

CREATE TABLE app.issued_bill_lines (
  id                       uuid    PRIMARY KEY DEFAULT uuidv7(),
  bill_id                  uuid    NOT NULL REFERENCES app.issued_bills (id),
  position                 integer NOT NULL,
  kind                     text    NOT NULL,
  description              text    NOT NULL,
  net_pence                bigint  NOT NULL,
  vat_treatment            text    NOT NULL,
  vat_rate_percent         integer NOT NULL,
  vat_pence                bigint  NOT NULL,
  gross_pence              bigint  NOT NULL,
  source_time_entry_id     uuid    REFERENCES app.time_entries (id),
  time_worker_name         text,
  time_worked_on           date,
  time_minutes             integer,
  time_hourly_rate_pence   bigint,

  CONSTRAINT issued_bill_lines_totals_valid CHECK (
    net_pence > 0 AND vat_pence >= 0 AND gross_pence = net_pence + vat_pence
  ),
  CONSTRAINT issued_bill_lines_rate_valid CHECK (vat_rate_percent IN (0, 5, 20)),
  CONSTRAINT issued_bill_lines_time_complete CHECK (
    (source_time_entry_id IS NULL AND time_worker_name IS NULL AND time_worked_on IS NULL
      AND time_minutes IS NULL AND time_hourly_rate_pence IS NULL)
    OR
    (source_time_entry_id IS NOT NULL AND time_worker_name IS NOT NULL AND time_worked_on IS NOT NULL
      AND time_minutes IS NOT NULL AND time_hourly_rate_pence IS NOT NULL)
  ),
  CONSTRAINT issued_bill_lines_position_unique UNIQUE (bill_id, position),
  CONSTRAINT issued_bill_lines_time_unique UNIQUE (source_time_entry_id)
);

CREATE INDEX issued_bill_lines_bill_idx ON app.issued_bill_lines (bill_id, position);

CREATE TABLE app.credit_notes (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  number       bigint      NOT NULL,
  reference    text        GENERATED ALWAYS AS
    ('CRN-' || lpad(number::text, greatest(6, length(number::text)), '0')) STORED,
  bill_id      uuid        NOT NULL REFERENCES app.issued_bills (id),
  reason       text        NOT NULL,
  net_pence    bigint      NOT NULL,
  vat_pence    bigint      NOT NULL,
  gross_pence  bigint      NOT NULL,
  issued_by    uuid        NOT NULL REFERENCES app.accounts (id),
  issued_on    date        NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'Europe/London')::date),
  issued_at    timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT credit_notes_number_positive CHECK (number > 0),
  CONSTRAINT credit_notes_reason_valid CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500 AND app.is_safe_text(reason)
  ),
  CONSTRAINT credit_notes_totals_valid CHECK (
    net_pence > 0 AND vat_pence >= 0 AND gross_pence = net_pence + vat_pence
  ),
  CONSTRAINT credit_notes_number_unique UNIQUE (number),
  CONSTRAINT credit_notes_reference_unique UNIQUE (reference)
);

CREATE INDEX credit_notes_bill_idx ON app.credit_notes (bill_id, number);

CREATE TABLE app.credit_note_lines (
  id            uuid   PRIMARY KEY DEFAULT uuidv7(),
  credit_note_id uuid  NOT NULL REFERENCES app.credit_notes (id),
  position      integer NOT NULL,
  bill_line_id  uuid    NOT NULL REFERENCES app.issued_bill_lines (id),
  net_pence     bigint  NOT NULL,
  vat_pence     bigint  NOT NULL,
  gross_pence   bigint  NOT NULL,

  CONSTRAINT credit_note_lines_totals_valid CHECK (
    net_pence > 0 AND vat_pence >= 0 AND gross_pence = net_pence + vat_pence
  ),
  CONSTRAINT credit_note_lines_position_unique UNIQUE (credit_note_id, position),
  CONSTRAINT credit_note_lines_bill_line_unique UNIQUE (credit_note_id, bill_line_id)
);

CREATE INDEX credit_note_lines_credit_idx ON app.credit_note_lines (credit_note_id, position);
CREATE INDEX credit_note_lines_bill_line_idx ON app.credit_note_lines (bill_line_id);

CREATE TABLE app.bill_deliveries (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id        uuid        REFERENCES app.issued_bills (id),
  credit_note_id uuid        REFERENCES app.credit_notes (id),
  document_type  text        NOT NULL,
  method         text        NOT NULL,
  note           text,
  delivered_by   uuid        NOT NULL REFERENCES app.accounts (id),
  delivered_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT bill_deliveries_one_document CHECK (num_nonnulls(bill_id, credit_note_id) = 1),
  CONSTRAINT bill_deliveries_type_matches CHECK (
    (bill_id IS NOT NULL AND document_type = 'bill')
    OR (credit_note_id IS NOT NULL AND document_type = 'credit_note')
  ),
  CONSTRAINT bill_deliveries_method_valid CHECK (method IN ('email', 'post', 'hand', 'other')),
  CONSTRAINT bill_deliveries_note_valid CHECK (
    note IS NULL OR (length(btrim(note)) BETWEEN 1 AND 500 AND app.is_safe_text(note))
  )
);

CREATE INDEX bill_deliveries_bill_idx ON app.bill_deliveries (bill_id, id);
CREATE INDEX bill_deliveries_credit_idx ON app.bill_deliveries (credit_note_id, id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.bill_drafts, app.bill_draft_lines, app.issued_bills, app.issued_bill_lines,
  app.credit_notes, app.credit_note_lines, app.bill_deliveries
FROM pms_app;

CREATE FUNCTION app.assert_active_accounts(actor_id uuid) RETURNS void
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
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.assert_active_accounts(uuid) FROM PUBLIC;

CREATE FUNCTION app.validate_bill_supplier_and_lines(supplier jsonb, lines jsonb) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  line jsonb;
BEGIN
  IF jsonb_typeof(supplier) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(supplier) key)
       IS DISTINCT FROM ARRAY['address_line1', 'address_line2', 'country', 'name', 'postcode', 'town', 'vat_registration_number']::text[]
  THEN
    RAISE EXCEPTION 'supplier fields are not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'a bill needs between 1 and 100 lines' USING ERRCODE = 'check_violation';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(line) key)
         IS DISTINCT FROM ARRAY['description', 'kind', 'net_pence', 'time_entry_id', 'vat_treatment']::text[]
    THEN
      RAISE EXCEPTION 'bill line fields are not valid' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(lines) AS item(value)
    WHERE item.value->>'vat_treatment' IN ('standard', 'reduced', 'zero')
  ) AND nullif(btrim(supplier->>'vat_registration_number'), '') IS NULL THEN
    RAISE EXCEPTION 'taxable lines require the supplier VAT registration number'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_bill_supplier_and_lines(jsonb, jsonb) FROM PUBLIC;

CREATE FUNCTION app.store_bill_draft_lines(target_draft uuid, target_matter uuid, lines jsonb) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  line jsonb;
  line_number integer := 0;
  selected_time uuid;
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    line_number := line_number + 1;
    selected_time := nullif(line->>'time_entry_id', '')::uuid;
    IF selected_time IS NOT NULL AND line->>'kind' <> 'fee' THEN
      RAISE EXCEPTION 'a time entry can be linked only to a fee line'
        USING ERRCODE = 'check_violation';
    END IF;
    IF selected_time IS NOT NULL THEN
      PERFORM 1
      FROM app.time_entries t
      WHERE t.id = selected_time AND t.matter_id = target_matter AND NOT t.voided
      FOR SHARE OF t;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the linked time entry is not available for this matter'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    INSERT INTO app.bill_draft_lines (
      draft_id, position, kind, description, net_pence, vat_treatment, time_entry_id
    ) VALUES (
      target_draft, line_number, line->>'kind', line->>'description',
      (line->>'net_pence')::bigint, line->>'vat_treatment', selected_time
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app.store_bill_draft_lines(uuid, uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app.create_bill_draft(
  target_matter uuid, selected_tax_point date, selected_due_on date,
  supplier jsonb, lines jsonb, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  PERFORM 1 FROM app.matters m WHERE m.id = target_matter AND m.status = 'open' FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a draft bill requires an open matter' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_tax_point > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'the tax point cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_due_on < selected_tax_point THEN
    RAISE EXCEPTION 'the due date cannot be before the tax point' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.validate_bill_supplier_and_lines(supplier, lines);
  INSERT INTO app.bill_drafts (
    matter_id, tax_point, due_on, supplier_name, supplier_address_line1,
    supplier_address_line2, supplier_town, supplier_postcode, supplier_country,
    supplier_vat_registration_number, created_by, updated_by
  ) VALUES (
    target_matter, selected_tax_point, selected_due_on, supplier->>'name', supplier->>'address_line1',
    nullif(supplier->>'address_line2', ''), supplier->>'town', nullif(supplier->>'postcode', ''),
    supplier->>'country', nullif(supplier->>'vat_registration_number', ''), actor_id, actor_id
  ) RETURNING id INTO new_id;
  PERFORM app.store_bill_draft_lines(new_id, target_matter, lines);
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_bill_draft(uuid, date, date, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_bill_draft(uuid, date, date, jsonb, jsonb, uuid) TO pms_app;

CREATE FUNCTION app.replace_bill_draft(
  target_draft uuid, selected_tax_point date, selected_due_on date,
  supplier jsonb, lines jsonb, actor_id uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_matter uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT matter_id INTO selected_matter FROM app.bill_drafts WHERE id = target_draft FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft bill with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM app.issued_bills WHERE draft_id = target_draft) THEN
    RAISE EXCEPTION 'an issued draft cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_tax_point > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'the tax point cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_due_on < selected_tax_point THEN
    RAISE EXCEPTION 'the due date cannot be before the tax point' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.validate_bill_supplier_and_lines(supplier, lines);
  UPDATE app.bill_drafts SET
    tax_point = selected_tax_point, due_on = selected_due_on,
    supplier_name = supplier->>'name', supplier_address_line1 = supplier->>'address_line1',
    supplier_address_line2 = nullif(supplier->>'address_line2', ''), supplier_town = supplier->>'town',
    supplier_postcode = nullif(supplier->>'postcode', ''), supplier_country = supplier->>'country',
    supplier_vat_registration_number = nullif(supplier->>'vat_registration_number', ''),
    updated_by = actor_id, updated_at = clock_timestamp()
  WHERE id = target_draft;
  DELETE FROM app.bill_draft_lines WHERE draft_id = target_draft;
  PERFORM app.store_bill_draft_lines(target_draft, selected_matter, lines);
END;
$$;

REVOKE ALL ON FUNCTION app.replace_bill_draft(uuid, date, date, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.replace_bill_draft(uuid, date, date, jsonb, jsonb, uuid) TO pms_app;

CREATE FUNCTION app.issue_bill(target_draft uuid, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  draft app.bill_drafts%ROWTYPE;
  matter app.matters%ROWTYPE;
  selected_client app.clients%ROWTYPE;
  new_bill uuid;
  next_number bigint;
  selected_client_name text;
  address1 text;
  address2 text;
  selected_town text;
  selected_postcode text;
  selected_country text;
  total_net bigint;
  total_vat bigint;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  SELECT * INTO draft FROM app.bill_drafts WHERE id = target_draft FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft bill with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM app.issued_bills WHERE draft_id = target_draft) THEN
    RAISE EXCEPTION 'this draft has already been issued' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO matter FROM app.matters WHERE id = draft.matter_id FOR SHARE;
  SELECT * INTO selected_client FROM app.clients WHERE id = matter.client_id FOR SHARE;
  SELECT coalesce(o.legal_name, i.given_names || ' ' || i.family_name),
         coalesce(o.address_line1, i.address_line1), coalesce(o.address_line2, i.address_line2),
         coalesce(o.town, i.town), coalesce(o.postcode, i.postcode), coalesce(o.country, i.country)
  INTO selected_client_name, address1, address2, selected_town, selected_postcode, selected_country
  FROM app.clients c
  LEFT JOIN app.client_individuals i ON i.client_id = c.id
  LEFT JOIN app.client_organisations o ON o.client_id = c.id
  WHERE c.id = matter.client_id;
  IF address1 IS NULL OR selected_town IS NULL OR selected_country IS NULL THEN
    RAISE EXCEPTION 'the client needs a complete client address before issue'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1
  FROM app.time_entries t
  JOIN app.bill_draft_lines dl ON dl.time_entry_id = t.id
  WHERE dl.draft_id = target_draft
  ORDER BY t.id
  FOR UPDATE OF t;
  IF EXISTS (
    SELECT 1 FROM app.bill_draft_lines dl
    JOIN app.time_entries t ON t.id = dl.time_entry_id
    WHERE dl.draft_id = target_draft AND (t.voided OR t.matter_id <> draft.matter_id)
  ) THEN
    RAISE EXCEPTION 'a linked time entry is no longer available' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.bill_draft_lines dl
    JOIN app.issued_bill_lines il ON il.source_time_entry_id = dl.time_entry_id
    WHERE dl.draft_id = target_draft AND dl.time_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a linked time entry has already been billed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum(net_pence), sum(
    CASE vat_treatment WHEN 'standard' THEN (net_pence * 20 + 50) / 100
                       WHEN 'reduced' THEN (net_pence * 5 + 50) / 100 ELSE 0 END
  ) INTO total_net, total_vat FROM app.bill_draft_lines WHERE draft_id = target_draft;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.issued_bill_number', 0));
  SELECT coalesce(max(number), 0) + 1 INTO next_number FROM app.issued_bills;
  INSERT INTO app.issued_bills (
    draft_id, number, matter_id, client_id, matter_reference, client_reference,
    client_name, client_address_line1, client_address_line2, client_town, client_postcode,
    client_country, supplier_name, supplier_address_line1, supplier_address_line2,
    supplier_town, supplier_postcode, supplier_country, supplier_vat_registration_number,
    tax_point, due_on, net_pence, vat_pence, gross_pence, issued_by
  ) VALUES (
    target_draft, next_number, matter.id, selected_client.id, matter.reference, selected_client.reference,
    selected_client_name, address1, address2, selected_town, selected_postcode,
    selected_country, draft.supplier_name, draft.supplier_address_line1, draft.supplier_address_line2,
    draft.supplier_town, draft.supplier_postcode, draft.supplier_country, draft.supplier_vat_registration_number,
    draft.tax_point, draft.due_on, total_net, total_vat, total_net + total_vat, actor_id
  ) RETURNING id INTO new_bill;

  INSERT INTO app.issued_bill_lines (
    bill_id, position, kind, description, net_pence, vat_treatment, vat_rate_percent,
    vat_pence, gross_pence, source_time_entry_id, time_worker_name, time_worked_on,
    time_minutes, time_hourly_rate_pence
  )
  SELECT new_bill, dl.position, dl.kind, dl.description, dl.net_pence, dl.vat_treatment,
         CASE dl.vat_treatment WHEN 'standard' THEN 20 WHEN 'reduced' THEN 5 ELSE 0 END,
         CASE dl.vat_treatment WHEN 'standard' THEN (dl.net_pence * 20 + 50) / 100
                               WHEN 'reduced' THEN (dl.net_pence * 5 + 50) / 100 ELSE 0 END,
         dl.net_pence + CASE dl.vat_treatment WHEN 'standard' THEN (dl.net_pence * 20 + 50) / 100
                                              WHEN 'reduced' THEN (dl.net_pence * 5 + 50) / 100 ELSE 0 END,
         dl.time_entry_id, a.display_name, t.worked_on, t.minutes, t.hourly_rate_pence
  FROM app.bill_draft_lines dl
  LEFT JOIN app.time_entries t ON t.id = dl.time_entry_id
  LEFT JOIN app.accounts a ON a.id = t.worker_id
  WHERE dl.draft_id = target_draft
  ORDER BY dl.position;
  RETURN new_bill;
END;
$$;

REVOKE ALL ON FUNCTION app.issue_bill(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_bill(uuid, uuid) TO pms_app;

CREATE FUNCTION app.issue_credit_note(target_bill uuid, selected_reason text, lines jsonb, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  line jsonb;
  line_number integer := 0;
  selected_line app.issued_bill_lines%ROWTYPE;
  selected_line_id uuid;
  selected_net bigint;
  credited_net bigint;
  credited_vat bigint;
  selected_vat bigint;
  new_credit uuid;
  next_number bigint;
  total_net bigint := 0;
  total_vat bigint := 0;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  PERFORM 1 FROM app.issued_bills b WHERE b.id = target_bill FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no issued bill with this id' USING ERRCODE = 'no_data_found';
  END IF;
  IF length(btrim(selected_reason)) NOT BETWEEN 1 AND 500 OR NOT app.is_safe_text(selected_reason) THEN
    RAISE EXCEPTION 'a credit note needs a valid reason' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'a credit note needs between 1 and 100 lines' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT value->>'bill_line_id') FROM jsonb_array_elements(lines)) <> jsonb_array_length(lines) THEN
    RAISE EXCEPTION 'a credit note cannot contain a duplicate bill line' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.credit_note_number', 0));
  SELECT coalesce(max(number), 0) + 1 INTO next_number FROM app.credit_notes;
  -- Validate and total every line before creating the fixed header.
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    line_number := line_number + 1;
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(line) key)
         IS DISTINCT FROM ARRAY['bill_line_id', 'net_pence']::text[]
    THEN
      RAISE EXCEPTION 'credit note line fields are not valid' USING ERRCODE = 'check_violation';
    END IF;
    selected_line_id := (line->>'bill_line_id')::uuid;
    selected_net := (line->>'net_pence')::bigint;
    IF selected_net < 1 THEN
      RAISE EXCEPTION 'a credit amount must be positive' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO selected_line FROM app.issued_bill_lines
    WHERE id = selected_line_id AND bill_id = target_bill;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the bill line does not belong to this bill' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(cl.net_pence), 0), coalesce(sum(cl.vat_pence), 0)
    INTO credited_net, credited_vat
    FROM app.credit_note_lines cl WHERE cl.bill_line_id = selected_line_id;
    IF selected_net > selected_line.net_pence - credited_net THEN
      RAISE EXCEPTION 'the credit exceeds the line remaining amount' USING ERRCODE = 'check_violation';
    END IF;
    IF selected_net = selected_line.net_pence - credited_net THEN
      selected_vat := selected_line.vat_pence - credited_vat;
    ELSE
      selected_vat := least(
        (selected_net * selected_line.vat_rate_percent + 50) / 100,
        selected_line.vat_pence - credited_vat
      );
    END IF;
    total_net := total_net + selected_net;
    total_vat := total_vat + selected_vat;
  END LOOP;

  INSERT INTO app.credit_notes (number, bill_id, reason, net_pence, vat_pence, gross_pence, issued_by)
  VALUES (next_number, target_bill, selected_reason, total_net, total_vat, total_net + total_vat, actor_id)
  RETURNING id INTO new_credit;

  line_number := 0;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    line_number := line_number + 1;
    selected_line_id := (line->>'bill_line_id')::uuid;
    selected_net := (line->>'net_pence')::bigint;
    SELECT * INTO selected_line FROM app.issued_bill_lines WHERE id = selected_line_id;
    SELECT coalesce(sum(cl.net_pence), 0), coalesce(sum(cl.vat_pence), 0)
    INTO credited_net, credited_vat
    FROM app.credit_note_lines cl WHERE cl.bill_line_id = selected_line_id;
    IF selected_net = selected_line.net_pence - credited_net THEN
      selected_vat := selected_line.vat_pence - credited_vat;
    ELSE
      selected_vat := least(
        (selected_net * selected_line.vat_rate_percent + 50) / 100,
        selected_line.vat_pence - credited_vat
      );
    END IF;
    INSERT INTO app.credit_note_lines (
      credit_note_id, position, bill_line_id, net_pence, vat_pence, gross_pence
    ) VALUES (
      new_credit, line_number, selected_line_id, selected_net, selected_vat, selected_net + selected_vat
    );
  END LOOP;
  RETURN new_credit;
END;
$$;

REVOKE ALL ON FUNCTION app.issue_credit_note(uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_credit_note(uuid, text, jsonb, uuid) TO pms_app;

CREATE FUNCTION app.record_bill_delivery(
  target_bill uuid, target_credit_note uuid, selected_method text, selected_note text, actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  new_id uuid;
BEGIN
  PERFORM app.assert_active_accounts(actor_id);
  IF num_nonnulls(target_bill, target_credit_note) <> 1 THEN
    RAISE EXCEPTION 'a delivery needs exactly one bill or credit note' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.bill_deliveries (
    bill_id, credit_note_id, document_type, method, note, delivered_by
  ) VALUES (
    target_bill, target_credit_note,
    CASE WHEN target_bill IS NOT NULL THEN 'bill' ELSE 'credit_note' END,
    selected_method, selected_note, actor_id
  ) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.record_bill_delivery(uuid, uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_bill_delivery(uuid, uuid, text, text, uuid) TO pms_app;

CREATE FUNCTION app.refuse_issued_finance_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued financial records cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_issued_finance_edit() FROM PUBLIC;

CREATE TRIGGER issued_bills_fixed BEFORE UPDATE OR DELETE ON app.issued_bills
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER issued_bill_lines_fixed BEFORE UPDATE OR DELETE ON app.issued_bill_lines
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER credit_notes_fixed BEFORE UPDATE OR DELETE ON app.credit_notes
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER credit_note_lines_fixed BEFORE UPDATE OR DELETE ON app.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER bill_deliveries_fixed BEFORE UPDATE OR DELETE ON app.bill_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_finance_edit();

CREATE TRIGGER issued_bills_no_truncate BEFORE TRUNCATE ON app.issued_bills
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER issued_bill_lines_no_truncate BEFORE TRUNCATE ON app.issued_bill_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER credit_notes_no_truncate BEFORE TRUNCATE ON app.credit_notes
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER credit_note_lines_no_truncate BEFORE TRUNCATE ON app.credit_note_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER bill_deliveries_no_truncate BEFORE TRUNCATE ON app.bill_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();

CREATE FUNCTION app.refuse_issued_draft_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  selected_draft uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    selected_draft := NEW.draft_id;
  ELSIF TG_TABLE_NAME = 'bill_drafts' THEN
    selected_draft := OLD.id;
  ELSE
    selected_draft := OLD.draft_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.issued_bills b
    WHERE b.draft_id = selected_draft
  ) THEN
    RAISE EXCEPTION 'an issued draft cannot be altered or removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_issued_draft_edit() FROM PUBLIC;

CREATE TRIGGER bill_drafts_issued_fixed BEFORE UPDATE OR DELETE ON app.bill_drafts
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_draft_edit();
CREATE TRIGGER bill_draft_lines_issued_fixed BEFORE INSERT OR UPDATE OR DELETE ON app.bill_draft_lines
  FOR EACH ROW EXECUTE FUNCTION app.refuse_issued_draft_edit();

CREATE TRIGGER bill_drafts_no_truncate BEFORE TRUNCATE ON app.bill_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
CREATE TRIGGER bill_draft_lines_no_truncate BEFORE TRUNCATE ON app.bill_draft_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_issued_finance_edit();
