-- Preserve strict anonymous/recovery budgets while allowing verified users
-- behind an office NAT to share an address. Account limits remain independent.
ALTER TABLE app.api_request_limits DROP CONSTRAINT api_request_limits_scope_check;
ALTER TABLE app.api_request_limits ADD CONSTRAINT api_request_limits_scope_check
  CHECK(scope IN ('network','general','authentication','recovery','account'));

CREATE OR REPLACE FUNCTION app.consume_api_request_limit(p_scope text,p_subject bytea)
RETURNS TABLE(allowed boolean,retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE seconds integer; maximum integer; started timestamptz; current_hits integer;
BEGIN
  CASE p_scope
    WHEN 'network' THEN seconds:=60; maximum:=12000;
    WHEN 'general' THEN seconds:=60; maximum:=600;
    WHEN 'authentication' THEN seconds:=60; maximum:=600;
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
REVOKE ALL ON FUNCTION app.consume_api_request_limit(text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_api_request_limit(text,bytea) TO pms_app;
