-- ============================================================
-- 096_business_event_shadow_recheck.sql
-- Controlled requeue for shadow-rendering evidence after projector/template
-- fixes. This RPC never promotes delivery_mode and never touches active rows.
-- ============================================================

create or replace function public.requeue_business_event_shadow_projection(
  p_account_id uuid,
  p_event_types text[] default null,
  p_statuses text[] default array[
    'mismatched_legacy',
    'unsupported_projector',
    'comparison_missing',
    'failed'
  ]::text[]
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count integer;
begin
  if p_statuses is null or cardinality(p_statuses) = 0 then
    raise exception 'SHADOW_REQUEUE_STATUSES_REQUIRED';
  end if;

  if exists (
    select 1
    from unnest(p_statuses) as s(status)
    where s.status not in (
      'mismatched_legacy',
      'unsupported_projector',
      'comparison_missing',
      'failed',
      'native_only',
      'not_deliverable'
    )
  ) then
    raise exception 'SHADOW_REQUEUE_STATUS_NOT_ALLOWED';
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
     and beo.shadow_projection_status = any(p_statuses)
     and (
       p_event_types is null
       or cardinality(p_event_types) = 0
       or beo.event_type = any(p_event_types)
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.requeue_business_event_shadow_projection(
  uuid, text[], text[]
) from public, anon, authenticated;

grant execute on function public.requeue_business_event_shadow_projection(
  uuid, text[], text[]
) to service_role;
