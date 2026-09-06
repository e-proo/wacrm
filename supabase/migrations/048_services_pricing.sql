-- ============================================================
-- 048_services_pricing.sql — Services, revisions, pricing rules
--                                (Phase 2 §6 + §7)
--
-- Adds the executable side of the catalog:
--   • services                  — service identity row
--   • service_revisions         — immutable snapshot (description,
--                                 ai guidance, field_values JSONB,
--                                 pricing_rule_id, validity window)
--   • service_pricing_rules     — bounded JSON-driven pricing rule
--                                 (fixed / percentage / per_unit /
--                                 fixed_plus_percentage / tiered /
--                                 fx_buy_sell / manual_quote)
--   • service_activity_events   — append-only audit (publish,
--                                 status changes, manual quote)
--
-- All money amounts are stored as `numeric(20, 4)` so a 6-per-1000
-- fee on 100,000,000 stays exact. Strings cross JSON/TS boundaries
-- (see src/lib/services/pricing/decimal.ts).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) service_pricing_rules
-- ------------------------------------------------------------
-- Pricing rules are independent entities (a service may reference
-- a single one); we let rules be shared by multiple services so
-- editing one fee doesn't have to update every service row.
create table if not exists public.service_pricing_rules (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  -- Free-text label shown in the UI.
  name              text not null,
  -- 'fixed' | 'percentage' | 'per_unit' | 'fixed_plus_percentage'
  --   | 'tiered' | 'fx_buy_sell' | 'manual_quote'.
  kind              text not null
                      check (kind in (
                        'fixed',
                        'percentage',
                        'per_unit',
                        'fixed_plus_percentage',
                        'tiered',
                        'fx_buy_sell',
                        'manual_quote'
                      )),
  -- Currency for the fee output. ISO-like code; a separate
  -- vocabulary table (Phase 2 §17) enforces the closed list.
  fee_currency      text,
  input_currency    text,
  -- Soft min/max — the runtime clamps the final fee into this
  -- range. NULL = unbounded.
  minimum_fee       numeric(20, 4),
  maximum_fee       numeric(20, 4),
  -- Rounding mode + increment. Stored in `formula_config` so the
  -- shape is extensible; validated at the application layer.
  -- Examples: {"mode":"proportional","increment":"0.01"}.
  -- Phase 1 keeps `mode` to the closed set:
  --   'proportional' | 'ceil_started_unit' | 'floor_complete_unit'
  --   | 'nearest_unit'
  rounding_mode     text
                      check (rounding_mode is null or rounding_mode in (
                        'proportional',
                        'ceil_started_unit',
                        'floor_complete_unit',
                        'nearest_unit'
                      )),
  -- Bounded JSONB describing the rule body. Validated by the
  -- pricing compiler at publish / quote time — unknown keys are
  -- rejected there, NOT in SQL.
  formula_config    jsonb not null default '{}'::jsonb,
  -- Reserved for Phase 3+ tax policies; Phase 2 keeps it 'none'
  -- because inventing a tax engine here would be scope creep.
  tax_policy        text not null default 'none'
                      check (tax_policy in ('none')),
  -- A published pricing rule is immutable. Drafts can be edited
  -- then promoted.
  status            text not null default 'draft'
                      check (status in ('draft', 'published', 'superseded')),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  published_by      uuid references auth.users(id) on delete set null,
  published_at      timestamptz
);

create index if not exists service_pricing_rules_account_kind_idx
  on public.service_pricing_rules (account_id, kind);

alter table public.service_pricing_rules enable row level security;

drop policy if exists service_pricing_rules_select on public.service_pricing_rules;
create policy service_pricing_rules_select on public.service_pricing_rules for select
  using (is_account_member(account_id));

drop policy if exists service_pricing_rules_insert on public.service_pricing_rules;
create policy service_pricing_rules_insert on public.service_pricing_rules for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists service_pricing_rules_update on public.service_pricing_rules;
create policy service_pricing_rules_update on public.service_pricing_rules for update
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 2) services
-- ------------------------------------------------------------
create table if not exists public.services (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references accounts(id) on delete cascade,
  category_id             uuid not null references public.service_categories(id) on delete restrict,
  -- Free-text internal code (e.g. "COV-SANA-CASH").
  code                    text not null,
  slug                    text not null,
  name                    text not null,
  -- 'draft' | 'active' | 'paused' | 'archived'. Mirrors the agent
  -- status vocabulary intentionally.
  status                  text not null default 'draft'
                            check (status in ('draft', 'active', 'paused', 'archived')),
  current_revision_id     uuid,
  -- Optimistic-concurrency token for status mutations.
  version                 bigint not null default 1,
  created_by              uuid references auth.users(id) on delete set null,
  updated_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index if not exists services_account_code_uidx
  on public.services (account_id, code);

create unique index if not exists services_account_slug_uidx
  on public.services (account_id, slug);

create index if not exists services_account_category_status_idx
  on public.services (account_id, category_id, status);

alter table public.services enable row level security;

drop policy if exists services_select on public.services;
create policy services_select on public.services for select
  using (is_account_member(account_id));

drop policy if exists services_insert on public.services;
create policy services_insert on public.services for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists services_update on public.services;
create policy services_update on public.services for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists services_delete on public.services;
create policy services_delete on public.services for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_services_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists services_updated_at on public.services;
create trigger services_updated_at
  before update on public.services
  for each row execute function public.update_services_updated_at();

-- ------------------------------------------------------------
-- 3) service_revisions
-- ------------------------------------------------------------
create table if not exists public.service_revisions (
  id                          uuid primary key default gen_random_uuid(),
  account_id                  uuid not null references accounts(id) on delete cascade,
  service_id                  uuid not null references public.services(id) on delete cascade,
  revision_number             integer not null,
  -- The schema version that authored `field_values`. We snapshot
  -- this so a schema republish never silently re-interprets an
  -- old service's values.
  category_schema_version_id  uuid not null references public.service_category_schema_versions(id) on delete restrict,
  name                        text not null,
  public_description          text,
  -- Internal-only. The runtime feeds this into the agent prompt
  -- as guidance but never returns it to a customer.
  ai_guidance                 text,
  -- Admin-only. Never enters an agent prompt by default.
  internal_notes              text,
  -- JSONB validated against the schema version's field definitions
  -- (see src/lib/services/catalog/field-schema-compiler.ts).
  field_values                jsonb not null default '{}'::jsonb,
  pricing_rule_id             uuid references public.service_pricing_rules(id) on delete set null,
  -- Validity window. `valid_until NULL` = open-ended. Phase 2
  -- uses these for display only — the live quote check is owned
  -- by the service, not the revision.
  valid_from                  timestamptz,
  valid_until                 timestamptz,
  -- 'draft' | 'published' | 'superseded' | 'rejected'.
  status                      text not null default 'draft'
                                check (status in ('draft', 'published', 'superseded', 'rejected')),
  rejection_reason            text,
  created_by                  uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  published_by                uuid references auth.users(id) on delete set null,
  published_at                timestamptz
);

create unique index if not exists service_revisions_service_number_uidx
  on public.service_revisions (service_id, revision_number);

create index if not exists service_revisions_account_status_idx
  on public.service_revisions (account_id, status);

alter table public.service_revisions enable row level security;

drop policy if exists service_revisions_select on public.service_revisions;
create policy service_revisions_select on public.service_revisions for select
  using (is_account_member(account_id));

drop policy if exists service_revisions_insert on public.service_revisions;
create policy service_revisions_insert on public.service_revisions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists service_revisions_update on public.service_revisions;
create policy service_revisions_update on public.service_revisions for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose — revisions are immutable history.

-- Attach the FK from services now that the target table exists.
do $$
begin
  begin
    alter table public.services
      drop constraint services_current_revision_fk;
  exception when undefined_object then
    null;
  end;
end$$;
alter table public.services
  add constraint services_current_revision_fk
  foreign key (current_revision_id)
  references public.service_revisions(id)
  on delete set null
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 4) service_activity_events — append-only audit
-- ------------------------------------------------------------
create table if not exists public.service_activity_events (
  id            bigserial primary key,
  account_id    uuid not null references accounts(id) on delete cascade,
  -- 'service' | 'service_revision' | 'pricing_rule' | 'category'.
  target_type   text not null,
  target_id     uuid not null,
  -- 'service.created' | 'service.published' | 'service.status_changed'
  --   | 'pricing_rule.created' | 'pricing_rule.published'
  --   | 'category.created' | 'category.schema_published'
  event_type    text not null,
  actor_type    text not null default 'user'
                  check (actor_type in ('user', 'system', 'service')),
  actor_id      text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists service_activity_events_target_idx
  on public.service_activity_events (target_type, target_id, created_at desc);

create index if not exists service_activity_events_account_idx
  on public.service_activity_events (account_id, created_at desc);

alter table public.service_activity_events enable row level security;

-- Read-only for account members; writes happen via SECURITY DEFINER
-- RPCs (defined below) so the append-only contract is enforced.
drop policy if exists service_activity_events_select
  on public.service_activity_events;
create policy service_activity_events_select
  on public.service_activity_events for select
  using (is_account_member(account_id));

-- Service-role RPC for appending events. Narrow signature: the
-- caller passes everything the event needs, the RPC enforces the
-- append-only contract.
create or replace function public.append_service_activity_event(
  p_account_id  uuid,
  p_target_type text,
  p_target_id   uuid,
  p_event_type  text,
  p_actor_type  text,
  p_actor_id    text,
  p_payload     jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.service_activity_events (
    account_id, target_type, target_id, event_type,
    actor_type, actor_id, payload
  ) values (
    p_account_id, p_target_type, p_target_id, p_event_type,
    coalesce(p_actor_type, 'system'),
    coalesce(p_actor_id, ''),
    coalesce(p_payload, '{}'::jsonb)
  );
$$;

revoke all on function public.append_service_activity_event(
  uuid, text, uuid, text, text, text, jsonb
) from public;
grant execute on function public.append_service_activity_event(
  uuid, text, uuid, text, text, text, jsonb
) to service_role;
