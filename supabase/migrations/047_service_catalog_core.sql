-- ============================================================
-- 047_service_catalog_core.sql — Service catalog core (Phase 2 §5)
--
-- Adds the flexible-schema foundation for the services domain:
--   • service_categories               — category identity row
--   • service_category_schema_versions — immutable schema snapshot
--                                        (published versions never
--                                        mutate; next change = new
--                                        version row)
--   • service_field_definitions        — typed field metadata bound
--                                        to a SCHEMA VERSION (not the
--                                        category), so a published
--                                        service stays interpretable
--                                        against the schema it was
--                                        authored under
--
-- No services, no pricing, no coverage yet — those land in
-- migrations 048 + 049 + 050. This file only installs the
-- taxonomy + validation scaffolding the other tables lean on.
--
-- Multi-tenancy: every table carries `account_id NOT NULL` and is
-- covered by RLS that scopes reads/writes to the caller's account.
-- Writes are admin+ only.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) service_categories
-- ------------------------------------------------------------
create table if not exists public.service_categories (
  id                          uuid primary key default gen_random_uuid(),
  account_id                  uuid not null references accounts(id) on delete cascade,
  slug                        text not null,
  name                        text not null,
  description                 text,
  -- 'active' | 'inactive' | 'archived'. Archived keeps history;
  -- services already attached keep their revisions.
  status                      text not null default 'active'
                                check (status in ('active', 'inactive', 'archived')),
  -- Pointer to the currently-active schema version. NULL while no
  -- schema has been published yet (a category with only drafts).
  current_schema_version_id   uuid,
  created_by                  uuid references auth.users(id) on delete set null,
  updated_by                  uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index if not exists service_categories_account_slug_uidx
  on public.service_categories (account_id, slug);

create index if not exists service_categories_account_status_idx
  on public.service_categories (account_id, status);

alter table public.service_categories enable row level security;

drop policy if exists service_categories_select on public.service_categories;
create policy service_categories_select on public.service_categories for select
  using (is_account_member(account_id));

drop policy if exists service_categories_insert on public.service_categories;
create policy service_categories_insert on public.service_categories for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists service_categories_update on public.service_categories;
create policy service_categories_update on public.service_categories for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists service_categories_delete on public.service_categories;
create policy service_categories_delete on public.service_categories for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_service_categories_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists service_categories_updated_at on public.service_categories;
create trigger service_categories_updated_at
  before update on public.service_categories
  for each row execute function public.update_service_categories_updated_at();

-- ------------------------------------------------------------
-- 2) service_category_schema_versions — immutable schema snapshot
-- ------------------------------------------------------------
create table if not exists public.service_category_schema_versions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  category_id     uuid not null references public.service_categories(id) on delete cascade,
  version_number  integer not null,
  -- 'draft' | 'published' | 'superseded'. Once published, the row
  -- is treated as immutable — the next authoring iteration creates
  -- a new draft row with version_number+1.
  status          text not null default 'draft'
                    check (status in ('draft', 'published', 'superseded')),
  -- Free-text note shown in the diff / version history UI.
  change_note     text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  published_by    uuid references auth.users(id) on delete set null,
  published_at    timestamptz
);

create unique index if not exists service_category_schema_versions_category_number_uidx
  on public.service_category_schema_versions (category_id, version_number);

create index if not exists service_category_schema_versions_account_status_idx
  on public.service_category_schema_versions (account_id, status);

alter table public.service_category_schema_versions enable row level security;

drop policy if exists service_category_schema_versions_select
  on public.service_category_schema_versions;
create policy service_category_schema_versions_select
  on public.service_category_schema_versions for select
  using (is_account_member(account_id));

drop policy if exists service_category_schema_versions_insert
  on public.service_category_schema_versions;
create policy service_category_schema_versions_insert
  on public.service_category_schema_versions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists service_category_schema_versions_update
  on public.service_category_schema_versions;
create policy service_category_schema_versions_update
  on public.service_category_schema_versions for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose — versions are immutable history.

-- Attach the FK from service_categories now that the target table
-- exists. Same IF-NOT-EXISTS workaround as 045.
do $$
begin
  begin
    alter table public.service_categories
      drop constraint service_categories_current_schema_version_fk;
  exception when undefined_object then
    null;
  end;
end$$;
alter table public.service_categories
  add constraint service_categories_current_schema_version_fk
  foreign key (current_schema_version_id)
  references public.service_category_schema_versions(id)
  on delete set null
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 3) service_field_definitions — typed field metadata
-- ------------------------------------------------------------
-- One row per declared field on a schema version. The closed
-- `data_type` enum mirrors the application's bounded type registry
-- (see src/lib/services/catalog/field-types.ts). Adding new types
-- requires a migration + a code change.
create table if not exists public.service_field_definitions (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  schema_version_id uuid not null references public.service_category_schema_versions(id) on delete cascade,
  field_key         text not null,
  label             text not null,
  help_text         text,
  -- Closed list. The migration intentionally re-declares it here
  -- (rather than referencing a separate enum type) so a future
  -- addition only needs an updated CHECK + a code change — no
  -- ALTER TYPE in a hot path.
  data_type         text not null
                      check (data_type in (
                        'short_text', 'long_text',
                        'number', 'integer', 'boolean',
                        'money', 'currency', 'percentage', 'per_unit_rate',
                        'enum', 'multi_enum',
                        'region', 'payment_method',
                        'date', 'datetime'
                      )),
  required          boolean not null default false,
  -- 'public' | 'internal' | 'ai_only'. Drives DTO visibility:
  --   public  — surfaced to customers and AI agents alike
  --   internal — visible to admins only, never to AI
  --   ai_only   — visible to AI agents only, not to customers
  visibility        text not null default 'public'
                      check (visibility in ('public', 'internal', 'ai_only')),
  constraints       jsonb not null default '{}'::jsonb,
  display_order     integer not null default 100,
  is_filterable     boolean not null default false,
  created_at        timestamptz not null default now()
);

-- A field key is unique within a schema version.
create unique index if not exists service_field_definitions_schema_key_uidx
  on public.service_field_definitions (schema_version_id, field_key);

create index if not exists service_field_definitions_account_idx
  on public.service_field_definitions (account_id);

alter table public.service_field_definitions enable row level security;

drop policy if exists service_field_definitions_select
  on public.service_field_definitions;
create policy service_field_definitions_select
  on public.service_field_definitions for select
  using (is_account_member(account_id));

drop policy if exists service_field_definitions_insert
  on public.service_field_definitions;
create policy service_field_definitions_insert
  on public.service_field_definitions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists service_field_definitions_update
  on public.service_field_definitions;
create policy service_field_definitions_update
  on public.service_field_definitions for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists service_field_definitions_delete
  on public.service_field_definitions;
create policy service_field_definitions_delete
  on public.service_field_definitions for delete
  using (is_account_member(account_id, 'admin'));
