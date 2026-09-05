-- ============================================================
-- 040_ai_provider_connections.sql — Multi-provider connection entity
--
-- Adds an account-scoped `ai_provider_connections` table for storing
-- one or more provider credentials per account (Chat vs Embeddings
-- may use different connections), plus nullable link columns on
-- `ai_configs` for the future switch-over. This is an ADDITIVE
-- expand step: no existing column is touched, dropped, or re-typed.
-- The legacy `provider/api_key/model/embeddings_api_key` columns on
-- `ai_configs` remain fully readable by the existing code paths
-- until a future contract phase removes them.
--
-- RLS mirrors `ai_configs` (settings-class: any member may read
-- metadata; admin+ may write). The encrypted key is never returned
-- to the client over the connection DTO — callers select only the
-- safe columns listed in the connection service.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- connection entity
-- ------------------------------------------------------------
create table if not exists public.ai_provider_connections (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id) on delete cascade,
  name                  text not null,
  preset_id             text not null,
  protocol              text not null check (
    protocol in ('openai', 'anthropic')
  ),
  api_root              text not null,
  encrypted_api_key     text not null,
  -- Opaque, non-reversible-by-design (HMAC of the secret + server key).
  -- Used for cache invalidation + dedup, never returned to the client.
  connection_fingerprint text not null,
  status                text not null default 'unverified' check (
    status in ('unverified', 'verified', 'error', 'disabled')
  ),
  -- Bounded, normalized catalog JSON. Replaces any need to ship raw
  -- provider payloads client-side. Shape governed by the application
  -- layer (see providers/model-types.ts).
  catalog               jsonb,
  catalog_fetched_at    timestamptz,
  catalog_error_code    text,
  verified_at           timestamptz,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Keep one name per account; the UI relies on human-readable names.
  unique (account_id, name)
);

create index if not exists ai_provider_connections_account_id_idx
  on ai_provider_connections (account_id);

alter table ai_provider_connections enable row level security;

-- SELECT: any member (viewer+) can read metadata — needed for the
-- settings UI to render the connection list and to confirm an AI
-- setup exists. `encrypted_api_key` is never selected by a route
-- that touches the client (enforced in the service layer), but RLS
-- itself cannot redact a column, so the policy permits the read the
-- application layer strips the secret.
drop policy if exists ai_provider_connections_select on ai_provider_connections;
create policy ai_provider_connections_select on ai_provider_connections for select
  using (is_account_member(account_id));

drop policy if exists ai_provider_connections_insert on ai_provider_connections;
create policy ai_provider_connections_insert on ai_provider_connections for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_provider_connections_update on ai_provider_connections;
create policy ai_provider_connections_update on ai_provider_connections for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_provider_connections_delete on ai_provider_connections;
create policy ai_provider_connections_delete on ai_provider_connections for delete
  using (is_account_member(account_id, 'admin'));

-- updated_at trigger — reuse the project's convention.
create or replace function public.update_ai_provider_connections_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_provider_connections_updated_at on public.ai_provider_connections;
create trigger ai_provider_connections_updated_at
  before update on public.ai_provider_connections
  for each row
  execute function public.update_ai_provider_connections_updated_at();

-- ------------------------------------------------------------
-- ai_configs — additive Chat/Embeddings connection links
-- ------------------------------------------------------------
-- Nullable at the DB level; the application enforces the
-- "active config must point at a valid connection" invariant.
-- No CASCADE on the FK so an accidental connection removal never
-- silently disables an account's AI behaviour — it blocks the
-- delete at the service level instead (FR-CON-07).
alter table public.ai_configs
  add column if not exists chat_connection_id           uuid references public.ai_provider_connections(id),
  add column if not exists embedding_connection_id      uuid references public.ai_provider_connections(id),
  add column if not exists chat_model                   text,
  add column if not exists embedding_model              text,
  add column if not exists embedding_dimensions         integer,
  add column if not exists embedding_revision           text;

-- Indexes to support the dual-read + backfill lookups.
create index if not exists ai_configs_chat_connection_id_idx
  on public.ai_configs (chat_connection_id);
create index if not exists ai_configs_embedding_connection_id_idx
  on public.ai_configs (embedding_connection_id);
