-- Shared across API instances. No plaintext addresses, cookies or tokens are stored.
CREATE TABLE app.api_request_limits (
  scope text NOT NULL CHECK (scope IN ('general','authentication','recovery','account')),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash)=32),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits BETWEEN 1 AND 10000000),
  PRIMARY KEY(scope,subject_hash)
);
REVOKE ALL ON app.api_request_limits FROM pms_app;

CREATE FUNCTION app.consume_api_request_limit(p_scope text,p_subject bytea)
RETURNS TABLE(allowed boolean,retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE seconds integer; maximum integer; started timestamptz; current_hits integer;
BEGIN
  CASE p_scope
    WHEN 'general' THEN seconds:=60; maximum:=600;
    WHEN 'authentication' THEN seconds:=60; maximum:=60;
    WHEN 'recovery' THEN seconds:=600; maximum:=20;
    WHEN 'account' THEN seconds:=60; maximum:=300;
    ELSE RAISE EXCEPTION 'unknown request limit' USING ERRCODE='invalid_parameter_value';
  END CASE;
  started:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/seconds)*seconds);
  INSERT INTO app.api_request_limits AS existing(scope,subject_hash,window_start,hits)
    VALUES(p_scope,p_subject,started,1)
    ON CONFLICT(scope,subject_hash) DO UPDATE SET
      hits=CASE WHEN existing.window_start=excluded.window_start THEN least(existing.hits+1,10000000) ELSE 1 END,
      window_start=excluded.window_start
    RETURNING hits INTO current_hits;
  RETURN QUERY SELECT current_hits<=maximum,
    greatest(1,ceil(extract(epoch FROM started+make_interval(secs=>seconds)-clock_timestamp()))::integer);
END;
$$;
GRANT EXECUTE ON FUNCTION app.consume_api_request_limit(text,bytea) TO pms_app;

CREATE FUNCTION app.prune_api_request_limits() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
  DELETE FROM app.api_request_limits WHERE window_start<clock_timestamp()-interval '1 day';
$$;
GRANT EXECUTE ON FUNCTION app.prune_api_request_limits() TO pms_app;
