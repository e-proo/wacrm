-- ============================================================
-- 094_business_event_shadow_projection_evidence.sql
-- Persist Phase F/G shadow-rendering evidence before any cutover.
--
-- The previous shadow claim only stamped shadow_checked_at. That is useful for
-- concurrency but insufficient as cutover evidence because it does not record
-- whether projection matched the active legacy path.
--
-- This migration remains expand-only:
--   * no delivery_mode row is promoted to active
--   * no legacy notification path is disabled
--   * no customer message is sent
-- ============================================================

alter table public.business_event_outbox
  add column if not exists shadow_projection_status text not null default 'pending';

alter table public.business_event_outbox
  add column if not exists shadow_projection_attempts integer not null default 0;

alter table public.business_event_outbox
  add column if not exists shadow_projection_claimed_at timestamptz;

alter table public.business_event_outbox
  add column if not exists shadow_projection_checked_at timestamptz;

alter table public.business_event_outbox
  add column if not exists shadow_projection_error text;

alter table public.business_event_outbox
  add column if not exists shadow_render_hash text;

alter table public.business_event_outbox
  add column if not exists shadow_legacy_hash text;

do $$
begin
  begin
    alter table public.business_event_outbox
      add constraint business_event_outbox_shadow_projection_status_check
      check (shadow_projection_status in (
        'pending',
        'checking',
        'matched_legacy',
        'mismatched_legacy',
        'native_only',
        'not_deliverable',
        'unsupported_projector',
        'comparison_missing',
        'failed'
      ));
  exception when duplicate_object then
    null;
  end;
end$$;

do $$
begin
  begin
    alter table public.business_event_outbox
      add constraint business_event_outbox_shadow_projection_attempts_check
      check (shadow_projection_attempts >= 0);
  exception when duplicate_object then
    null;
  end;
end$$;

do $$
begin
  begin
    alter table public.business_event_outbox
      add constraint business_event_outbox_shadow_render_hash_check
      check (
        shadow_render_hash is null
        or shadow_render_hash ~ '^[0-9a-f]{64}$'
      );
  exception when duplicate_object then
    null;
  end;
end$$;

do $$
begin
  begin
    alter table public.business_event_outbox
      add constraint business_event_outbox_shadow_legacy_hash_check
      check (
        shadow_legacy_hash is null
        or shadow_legacy_hash ~ '^[0-9a-f]{64}$'
      );
  exception when duplicate_object then
    null;
  end;
end$$;

create index if not exists business_event_outbox_shadow_projection_idx
  on public.business_event_outbox(
    account_id,
    delivery_mode,
    shadow_projection_status,
    created_at
  );

comment on column public.business_event_outbox.shadow_projection_status is
  'Durable shadow-rendering evidence used to gate a future controlled cutover. It never activates delivery by itself.';

comment on column public.business_event_outbox.shadow_render_hash is
  'SHA-256 of newly projected text. Message text itself is not duplicated into cutover evidence.';

comment on column public.business_event_outbox.shadow_legacy_hash is
  'SHA-256 of the still-active legacy rendering when parity comparison is available.';

-- Preserve the original RPC return shape for compatibility. Internally, a row
-- now moves to checking and stale checks can be reclaimed after 15 minutes.
create or replace function public.claim_business_event_outbox_shadow(
  p_account_id uuid,
  p_limit integer default 50
)
returns table(
  id uuid,
  event_type text,
  event_version integer,
  subject_type text,
  subject_id text,
  audience text,
  channel text,
  contact_id uuid,
  conversation_id uuid,
  correlation_id text,
  causation_id text,
  payload jsonb,
  legacy_notification_id uuid,
  dedupe_key text,
  created_at timestamptz,
  shadow_checked_at timestamptz
)
language sql
security invoker
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select beo.id
    from public.business_event_outbox as beo
    where beo.account_id = p_account_id
      and beo.delivery_mode = 'shadow'
      and (
        beo.shadow_projection_status = 'pending'
        or (
          beo.shadow_projection_status = 'checking'
          and beo.shadow_projection_claimed_at
                < pg_catalog.now() - interval '15 minutes'
        )
      )
    order by beo.created_at asc, beo.id asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), checked as (
    update public.business_event_outbox as beo
       set shadow_projection_status = 'checking',
           shadow_projection_attempts = beo.shadow_projection_attempts + 1,
           shadow_projection_claimed_at = pg_catalog.now(),
           shadow_projection_error = null,
           shadow_checked_at = pg_catalog.now()
      from candidates as c
     where beo.id = c.id
    returning beo.*
  )
  select c.id,
         c.event_type,
         c.event_version,
         c.subject_type,
         c.subject_id,
         c.audience,
         c.channel,
         c.contact_id,
         c.conversation_id,
         c.correlation_id,
         c.causation_id,
         c.payload,
         c.legacy_notification_id,
         c.dedupe_key,
         c.created_at,
         c.shadow_checked_at
    from checked as c
   order by c.created_at asc, c.id asc;
$$;

revoke execute on function public.claim_business_event_outbox_shadow(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_business_event_outbox_shadow(uuid, integer)
  to service_role;
