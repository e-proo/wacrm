-- ============================================================
-- 100_business_event_shadow_stale_recovery.sql
-- Recover stale shadow verification claims after an interrupted verifier.
--
-- Safety:
--   * shadow rows only
--   * event-type scoped and account-scoped
--   * only checking rows older than the caller-provided stale threshold
--   * does not change delivery_mode, business status, or legacy notifications
--   * attempts are preserved for auditability
-- ============================================================

create or replace function public.requeue_stale_business_event_shadow_projection(
  p_account_id uuid,
  p_event_types text[],
  p_stale_after_seconds integer default 30
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count integer := 0;
begin
  if p_event_types is null or cardinality(p_event_types) = 0 then
    raise exception 'SHADOW_EVENT_TYPES_REQUIRED';
  end if;

  if p_stale_after_seconds < 15 or p_stale_after_seconds > 3600 then
    raise exception 'SHADOW_STALE_THRESHOLD_INVALID';
  end if;

  update public.business_event_outbox as beo
     set shadow_projection_status = 'pending',
         shadow_projection_claimed_at = null,
         shadow_projection_checked_at = null,
         shadow_projection_error = null,
         shadow_render_hash = null,
         shadow_legacy_hash = null
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'shadow'
     and beo.shadow_projection_status = 'checking'
     and beo.event_type = any(p_event_types)
     and beo.shadow_projection_claimed_at
           < pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_after_seconds);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.requeue_stale_business_event_shadow_projection(
  uuid, text[], integer
) from public, anon, authenticated;

grant execute on function public.requeue_stale_business_event_shadow_projection(
  uuid, text[], integer
) to service_role;
