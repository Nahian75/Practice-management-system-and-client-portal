-- Review C3: a client is also stranded when its responsible person stays
-- active but no longer holds a role that lets them see clients. A takeover is
-- now refused only while the responsible person can still see the client:
-- an account that is not disabled and holds one of the roles granting
-- clients.view. That list mirrors ROLE_PERMISSIONS in permissions.ts; a test
-- checks every role against both.
CREATE OR REPLACE FUNCTION app.apply_client_responsibility_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_responsible uuid;
BEGIN
  SELECT responsible_id INTO current_responsible FROM app.clients WHERE id = NEW.client_id FOR UPDATE;
  IF current_responsible IS DISTINCT FROM NEW.from_account_id THEN
    RAISE EXCEPTION 'client % is not the responsibility of %', NEW.client_id, NEW.from_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.from_account_id AND status <> 'disabled')
     AND EXISTS (
       SELECT 1 FROM app.account_roles
       WHERE account_id = NEW.from_account_id AND revoked_at IS NULL AND role IN ('partner', 'fee_earner')
     ) THEN
    RAISE EXCEPTION 'a client is taken over only from someone who can no longer see it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.to_account_id AND kind = 'staff' AND status = 'active') THEN
    RAISE EXCEPTION 'a client is taken over by an active staff account'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.clients SET responsible_id = NEW.to_account_id WHERE id = NEW.client_id;
  RETURN NEW;
END;
$$;
