-- NOTE-001 / SECURITY DEFINER signed-in RPC exposure.
-- Every existing client RPC keeps its public signature and original tenant/role
-- semantics. The original elevated routine (same OID) is moved to the
-- non-exposed wacrm_internal schema. A new SECURITY INVOKER facade is created
-- under public with the exact original arguments, defaults and return shape.
-- Do not simply mark the original implementation INVOKER: many routines
-- legitimately need atomic writes behind RLS.
--
-- Production is NOT an execution target for this migration.

DO $hardening$
DECLARE
  rec record;
  v_call text;
  v_return_statement text;
  v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='wacrm_internal')
     OR has_schema_privilege('anon','wacrm_internal','USAGE') THEN
    RAISE EXCEPTION 'Expected hardened, private wacrm_internal schema from migration 198';
  END IF;

  FOR rec IN
    SELECT p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_arguments(p.oid) AS declaration_args,
           pg_get_function_result(p.oid) AS result_type,
           p.proretset, p.prorettype, p.pronargs, p.proargnames
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
      'create_message_template_revision',
      'publish_ai_agent_revision_atomic',
      'publish_message_template_revision',
      'redeem_invitation',
      'remove_account_member',
      'replace_ai_agent_knowledge_base_assignments',
      'set_member_role',
      'set_trusted_admin_capabilities',
      'touch_presence',
      'transfer_account_ownership',
      'unpublish_message_template'
    ])
    ORDER BY p.proname
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=rec.oid)
       OR NOT has_function_privilege('authenticated',rec.oid,'EXECUTE')
       OR has_function_privilege('anon',rec.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected baseline ACL or definer flag on %',rec.proname;
    END IF;
    IF rec.proargnames IS NULL OR cardinality(rec.proargnames)<rec.pronargs THEN
      RAISE EXCEPTION 'Missing named parameters for %',rec.proname;
    END IF;
    SELECT string_agg(format('%I',a),', ' ORDER BY ord) INTO v_call
      FROM unnest(rec.proargnames) WITH ORDINALITY AS q(a,ord)
      WHERE ord<=rec.pronargs;
    IF rec.proretset THEN
      v_return_statement := format('RETURN QUERY SELECT * FROM wacrm_internal.%I(%s);',rec.proname,v_call);
    ELSIF rec.prorettype='void'::regtype THEN
      v_return_statement := format('PERFORM wacrm_internal.%I(%s);',rec.proname,v_call);
    ELSE
      v_return_statement := format('RETURN wacrm_internal.%I(%s);',rec.proname,v_call);
    END IF;

    -- ALTER FUNCTION preserves the trusted routine's OID, body, and any
    -- internal dependencies. It must not be exposed as a REST schema.
    EXECUTE format('ALTER FUNCTION public.%I(%s) SET SCHEMA wacrm_internal',
      rec.proname,rec.identity_args);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION wacrm_internal.%I(%s) FROM PUBLIC, anon, authenticated',
      rec.proname,rec.identity_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION wacrm_internal.%I(%s) TO authenticated, service_role',
      rec.proname,rec.identity_args);

    -- The facade requires a real user (or a trusted service_role token).
    -- Direct migration/smoke SQL under session_user=postgres remains
    -- possible; that session role cannot be impersonated via PostgREST.
    -- Original privileged code still checks account membership and roles.
    EXECUTE format(
      $wrapper$
      CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql
      SECURITY INVOKER SET search_path TO pg_catalog, public, auth, extensions
      AS $rpc_guard$
      BEGIN
        IF auth.uid() IS NULL
           AND coalesce(auth.role(),'') <> 'service_role'
           AND session_user <> 'postgres' THEN
           RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
        END IF;
        %s
      END;
      $rpc_guard$
      $wrapper$,
      rec.proname,rec.declaration_args,rec.result_type,v_return_statement
    );
    -- New functions default to EXECUTE for PUBLIC! Remove it explicitly.
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
      rec.proname,rec.identity_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role',
      rec.proname,rec.identity_args);
    v_count:=v_count+1;
  END LOOP;
  IF v_count<>11 THEN
    RAISE EXCEPTION 'Expected 11 authenticated definer routines, found %',v_count;
  END IF;
END
$hardening$;
