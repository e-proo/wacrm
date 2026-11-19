-- NOTE-001 remaining PostgreSQL Advisor hardening.
-- This migration intentionally does NOT touch auth leaked-password protection:
-- Supabase Auth service settings must be changed through its dashboard/API.
-- Applied only after verified 199, and only on the authorized TEST project.

-- Each of these 13 tables is explicitly server-owned (server workers,
-- internal audit, guardrails, or pilot enforcement). Keeping RLS enabled,
-- normalize policy metadata to a service_role-only contract, WITHOUT
-- granting the tables to anon/authenticated and WITHOUT exposing tenant data.
DO $server_only_rls$
DECLARE rec record; v_count integer:=0;
BEGIN
FOR rec IN
  SELECT c.oid,c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND c.relname=ANY(ARRAY[
      'ai_agent_coverage_supplier_negotiations',
      'ai_agent_task_scheduler_heartbeat',
      'ai_agent_task_trigger_claim_fairness',
      'ai_agent_task_worker_control_events',
      'automation_pending_executions',
      'broadcast_delivery_jobs',
      'openwa_deferred_events',
      'openwa_outbound_operator_reviews',
      'whatsapp_connection_guardrails',
      'whatsapp_guardrail_events',
      'whatsapp_openwa_pilot_admission_events',
      'whatsapp_openwa_pilot_allowlist',
      'whatsapp_openwa_pilot_mode_events'
    ])
LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=rec.oid)
    OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=rec.oid) THEN
    RAISE EXCEPTION 'Server-only RLS baseline changed for %',rec.relname;
  END IF;
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
    'service_role_only_'||rec.relname,rec.relname
  );
  v_count:=v_count+1;
END LOOP;
IF v_count<>13 THEN
  RAISE EXCEPTION 'Expected 13 service-role-only tables, found %',v_count;
END IF;
END $server_only_rls$;

-- This legacy table had client-level GRANTs, but no policies at all.
-- Formalize the existing deny-all client behavior with a table ACL revoke.
REVOKE ALL ON TABLE public.automation_pending_executions FROM anon, authenticated;

-- Restrict mutable function paths. pg_catalog is first, untrusted
-- temporary objects are last, and extensions remains discoverable.
DO $fixed_paths$
DECLARE rec record; n integer:=0;
BEGIN
FOR rec IN
  SELECT p.oid,p.proname FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname=ANY(ARRAY[
    '_bcast_cols_for_status',
    'update_updated_at_column',
    'update_ai_configs_updated_at',
    'update_ai_knowledge_documents_updated_at',
    'update_trusted_admin_identities_updated_at',
    'update_ai_provider_connections_updated_at',
    'update_service_categories_updated_at',
    'update_services_updated_at',
    'update_coverage_offers_updated_at',
    'update_coverage_requests_updated_at',
    'update_currencies_updated_at',
    'trg_seed_default_currencies_on_account',
    'update_ai_reconciliation_jobs_updated_at',
    'update_coverage_regions_updated_at',
    'trg_seed_default_coverage_regions_on_account',
    'trg_seed_default_coverage_service_on_account'
  ])
LOOP
  IF (SELECT proconfig IS NOT NULL FROM pg_proc WHERE oid=rec.oid) THEN
     RAISE EXCEPTION 'Mutable search_path baseline unexpectedly changed for %',rec.proname;
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %s SET search_path TO pg_catalog, public, extensions, pg_temp',
    rec.oid::regprocedure
  );
  n:=n+1;
END LOOP;
IF n<>16 THEN RAISE EXCEPTION 'Expected 16 mutable routines, found %',n; END IF;
END $fixed_paths$;

-- pgvector is relocatable. Move its types/operators as a unit, without
-- dropping the extension, rebuilding vectors, or changing stored embeddings.
DO $vector$
DECLARE s text;
BEGIN
SELECT n.nspname INTO s
  FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
 WHERE e.extname='vector';
IF s='public' THEN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension
     WHERE extname='vector' AND extrelocatable
  ) THEN
     RAISE EXCEPTION 'vector extension is not relocatable';
  END IF;
  ALTER EXTENSION vector SET SCHEMA extensions;
ELSIF s IS DISTINCT FROM 'extensions' THEN
  RAISE EXCEPTION 'Unexpected pgvector schema: %',s;
END IF;
END $vector$;

-- These two semantic search functions contain unqualified ::vector and <=>
-- operators, so they MUST see the extension's new schema at runtime.
ALTER FUNCTION public.match_ai_knowledge_semantic(uuid,text,integer,text)
  SET search_path TO pg_catalog, public, extensions, pg_temp;
ALTER FUNCTION public.match_ai_knowledge_v2_semantic(uuid,uuid,text,integer,text,uuid,text)
  SET search_path TO pg_catalog, public, extensions, pg_temp;
