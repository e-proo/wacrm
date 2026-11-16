-- Durable queue schema, SQL lease and privilege smoke; never dispatches a message.
DO $$
DECLARE v_rls boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class
    WHERE oid='public.broadcast_delivery_jobs'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Queue must enforce RLS';
  END IF;
  IF has_table_privilege('anon','public.broadcast_delivery_jobs','SELECT') OR
     has_table_privilege('authenticated','public.broadcast_delivery_jobs','INSERT') OR
     NOT has_table_privilege('service_role','public.broadcast_delivery_jobs','UPDATE') THEN
    RAISE EXCEPTION 'Invalid queue grants';
  END IF;
  IF has_function_privilege('anon','public.enqueue_broadcast_delivery_job(uuid,uuid,text,text)','EXECUTE') OR
     has_function_privilege('authenticated','public.claim_broadcast_delivery_job(text)','EXECUTE') OR
     has_function_privilege('authenticated','public.finish_broadcast_delivery_job(uuid,uuid,text,integer,text)','EXECUTE') OR
     NOT has_function_privilege('service_role','public.claim_broadcast_delivery_job(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Durable worker RPCs must be service-role only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
     AND tablename='broadcast_delivery_jobs' AND indexname='idx_broadcast_jobs_work'
  ) THEN
    RAISE EXCEPTION 'Durable queue work index missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='broadcast_recipients' AND column_name='dispatch_reserved_at'
  ) THEN
    RAISE EXCEPTION 'Recipient dispatch reservation time missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='broadcasts' AND column_name='broadcast_header_media_url'
  ) THEN
    RAISE EXCEPTION 'Frozen Meta media header missing';
  END IF;
END $$;
