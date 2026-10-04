-- Review C4: the database refuses control characters, line separators and
-- text-direction overrides in client text too, as the API already does.
-- The characters are listed explicitly rather than with [[:cntrl:]], whose
-- meaning depends on the server's locale; the API's UNSAFE_CHARACTERS uses
-- the same list. (A null byte cannot be stored in text at all.)
CREATE FUNCTION app.is_safe_text(value text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN value !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]';

-- New functions carry no EXECUTE right by default (see 01-roles.sh), and the
-- checks below run with the rights of whoever writes the row.
GRANT EXECUTE ON FUNCTION app.is_safe_text(text) TO pms_app;

ALTER TABLE app.client_individuals ADD CONSTRAINT client_individuals_text_safe CHECK (
  app.is_safe_text(title) AND app.is_safe_text(given_names) AND app.is_safe_text(family_name)
  AND app.is_safe_text(email) AND app.is_safe_text(phone)
  AND app.is_safe_text(address_line1) AND app.is_safe_text(address_line2)
  AND app.is_safe_text(town) AND app.is_safe_text(postcode) AND app.is_safe_text(country)
);

ALTER TABLE app.client_organisations ADD CONSTRAINT client_organisations_text_safe CHECK (
  app.is_safe_text(legal_name) AND app.is_safe_text(registration_number)
  AND app.is_safe_text(email) AND app.is_safe_text(phone)
  AND app.is_safe_text(address_line1) AND app.is_safe_text(address_line2)
  AND app.is_safe_text(town) AND app.is_safe_text(postcode) AND app.is_safe_text(country)
);

ALTER TABLE app.client_contacts ADD CONSTRAINT client_contacts_text_safe CHECK (
  app.is_safe_text(given_names) AND app.is_safe_text(family_name) AND app.is_safe_text(job_title)
  AND app.is_safe_text(email) AND app.is_safe_text(phone)
);

ALTER TABLE app.client_responsibility_changes ADD CONSTRAINT client_responsibility_changes_reason_safe CHECK (
  app.is_safe_text(reason)
);
