-- Financial access does not authorize attaching a file the actor cannot view.
-- Keep this check in PostgreSQL as well as filtering the UI's receipt choices.
CREATE FUNCTION app.check_expense_receipt_access() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.receipt_version_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM app.accounts a
    JOIN app.account_roles r ON r.account_id=a.id
    JOIN app.matter_team t ON t.account_id=a.id
    WHERE a.id=NEW.recorded_by AND a.kind='staff' AND a.status='active'
      AND r.role IN ('partner','fee_earner') AND r.revoked_at IS NULL
      AND t.matter_id=NEW.matter_id AND t.removed_at IS NULL
    FOR SHARE OF a,r,t;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_expense_receipt_access() FROM PUBLIC;
CREATE TRIGGER matter_expense_receipt_access BEFORE INSERT ON app.matter_expenses
  FOR EACH ROW EXECUTE FUNCTION app.check_expense_receipt_access();
