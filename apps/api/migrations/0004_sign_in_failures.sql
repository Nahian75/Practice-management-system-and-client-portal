-- One row per rejected sign-in. Used to block an account after repeated wrong
-- passwords, and (later) to rate-limit an IP address.
CREATE TABLE app.sign_in_failures (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid        REFERENCES app.accounts (id),
  reason      text        NOT NULL,
  ip_address  inet,
  occurred_at timestamptz NOT NULL,

  CONSTRAINT sign_in_failures_reason_valid
    CHECK (reason IN ('unknown_account', 'wrong_password', 'account_not_active')),
  CONSTRAINT sign_in_failures_account_matches_reason
    CHECK ((reason = 'unknown_account') = (account_id IS NULL))
);

CREATE INDEX sign_in_failures_account_idx ON app.sign_in_failures (account_id, occurred_at)
  WHERE account_id IS NOT NULL;
CREATE INDEX sign_in_failures_ip_idx ON app.sign_in_failures (ip_address, occurred_at);

-- occurred_at comes from the app clock, the same clock that decides whether an
-- account is blocked: time limits must be measured against a single clock.
-- Rows are never changed or deleted by the app.
