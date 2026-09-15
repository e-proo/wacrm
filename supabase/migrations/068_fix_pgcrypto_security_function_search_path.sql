-- Fix runtime lookup of pgcrypto functions from SECURITY DEFINER functions.
--
-- Migration 065 intentionally pinned these functions to `search_path = public`
-- to avoid search-path injection. On Supabase, pgcrypto is commonly installed in
-- the `extensions` schema, so unqualified digest/crypt/gen_salt/gen_random_bytes
-- calls fail at runtime. Keep 065 immutable and repair the function configuration
-- additively by discovering pgcrypto's actual extension schema.

begin;

do $$
declare
  v_pgcrypto_schema text;
begin
  select n.nspname
    into v_pgcrypto_schema
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_pgcrypto_schema is null then
    raise exception 'pgcrypto extension is required for trusted-admin and change-request security functions';
  end if;

  if to_regprocedure(format('%I.digest(text,text)', v_pgcrypto_schema)) is null
     or to_regprocedure(format('%I.crypt(text,text)', v_pgcrypto_schema)) is null
     or to_regprocedure(format('%I.gen_salt(text,integer)', v_pgcrypto_schema)) is null
     or to_regprocedure(format('%I.gen_random_bytes(integer)', v_pgcrypto_schema)) is null then
    raise exception 'pgcrypto functions are incomplete in schema %', v_pgcrypto_schema;
  end if;

  execute format(
    'alter function public.verify_trusted_admin_otp_v2(uuid,uuid,text,uuid) set search_path to pg_catalog, public, %I',
    v_pgcrypto_schema
  );
  execute format(
    'alter function public.create_change_request_v2(uuid,text,uuid,text,jsonb,bigint,text,text,uuid) set search_path to pg_catalog, public, %I',
    v_pgcrypto_schema
  );
  execute format(
    'alter function public.approve_change_request_by_code_v2(uuid,integer,text,uuid,uuid,uuid) set search_path to pg_catalog, public, %I',
    v_pgcrypto_schema
  );
  execute format(
    'alter function public.approve_change_request_dashboard_v2(uuid,uuid,text,uuid) set search_path to pg_catalog, public, %I',
    v_pgcrypto_schema
  );
  execute format(
    'alter function public.claim_change_request_execution(uuid,uuid) set search_path to pg_catalog, public, %I',
    v_pgcrypto_schema
  );
end
$$;

commit;
