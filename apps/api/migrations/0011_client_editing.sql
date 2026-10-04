-- Client details can be corrected and kept up to date. client_id stays fixed,
-- so details can never be moved to another client.
GRANT UPDATE (
  title, given_names, family_name, date_of_birth,
  email, phone, address_line1, address_line2, town, postcode, country
) ON app.client_individuals TO pms_app;

GRANT UPDATE (
  legal_name, organisation_type, registration_number,
  email, phone, address_line1, address_line2, town, postcode, country
) ON app.client_organisations TO pms_app;
