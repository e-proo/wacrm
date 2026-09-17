-- ============================================================
-- 067_dynamic_knowledge_registry.sql
-- Dynamic, account-owned knowledge bases for multi-agent RAG.
--
-- Goals:
--   * NO runtime dependency on repository/project files.
--   * Knowledge is managed dynamically in DB/storage-backed workflows.
--   * Agent revisions receive explicit KB assignments (fail closed).
--   * Retrieved text is reference data, never authorization/instructions.
--   * Only active/reviewed/effective content reaches an agent.
--   * Shared, agent-private, and service-linked KBs are supported.
--   * Existing 030-era documents/chunks are preserved and migrated.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Knowledge-base registry
-- ------------------------------------------------------------
create table if not exists public.ai_knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  description text,
  scope text not null default 'shared'
    check (scope in ('shared', 'agent_private', 'service')),
  owner_agent_id uuid references public.ai_agents(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  default_trust_level text not null default 'internal'
    check (default_trust_level in ('admin_verified', 'internal', 'external', 'untrusted')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_knowledge_bases_private_owner_check
    check ((scope = 'agent_private' and owner_agent_id is not null)
        or (scope <> 'agent_private'))
);

create unique index if not exists ai_knowledge_bases_account_slug_uidx
  on public.ai_knowledge_bases(account_id, slug);
create index if not exists ai_knowledge_bases_account_status_idx
  on public.ai_knowledge_bases(account_id, status);
create index if not exists ai_knowledge_bases_owner_agent_idx
  on public.ai_knowledge_bases(owner_agent_id)
  where owner_agent_id is not null;

alter table public.ai_knowledge_bases enable row level security;
drop policy if exists ai_knowledge_bases_select on public.ai_knowledge_bases;
create policy ai_knowledge_bases_select on public.ai_knowledge_bases for select
  using (is_account_member(account_id));
drop policy if exists ai_knowledge_bases_insert on public.ai_knowledge_bases;
create policy ai_knowledge_bases_insert on public.ai_knowledge_bases for insert
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_knowledge_bases_update on public.ai_knowledge_bases;
create policy ai_knowledge_bases_update on public.ai_knowledge_bases for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_knowledge_bases_delete on public.ai_knowledge_bases;
create policy ai_knowledge_bases_delete on public.ai_knowledge_bases for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.touch_ai_knowledge_base_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists ai_knowledge_bases_touch on public.ai_knowledge_bases;
create trigger ai_knowledge_bases_touch
before update on public.ai_knowledge_bases
for each row execute function public.touch_ai_knowledge_base_updated_at();


-- Tenant-integrity guard: an agent-private KB may only be owned by an
-- agent from the same account. Keep this in the DB so no API bug can
-- manufacture a cross-tenant relationship.
create or replace function public.guard_ai_knowledge_base_tenant()
returns trigger language plpgsql set search_path = public as $$
declare
  v_agent_account uuid;
begin
  if new.owner_agent_id is not null then
    select account_id into v_agent_account
      from public.ai_agents where id = new.owner_agent_id;
    if v_agent_account is null or v_agent_account is distinct from new.account_id then
      raise exception 'KNOWLEDGE_BASE_OWNER_ACCOUNT_MISMATCH' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_ai_knowledge_base_tenant on public.ai_knowledge_bases;
create trigger guard_ai_knowledge_base_tenant
before insert or update of account_id, owner_agent_id, scope on public.ai_knowledge_bases
for each row execute function public.guard_ai_knowledge_base_tenant();

-- ------------------------------------------------------------
-- 2) Evolve legacy documents into managed dynamic documents.
-- `project_file` is deliberately NOT an allowed source type.
-- ------------------------------------------------------------
alter table public.ai_knowledge_documents
  add column if not exists knowledge_base_id uuid references public.ai_knowledge_bases(id) on delete cascade,
  add column if not exists source_type text,
  add column if not exists source_uri text,
  add column if not exists lifecycle_status text,
  add column if not exists trust_level text,
  add column if not exists language text not null default 'auto',
  add column if not exists effective_from timestamptz,
  add column if not exists effective_until timestamptz,
  add column if not exists injection_risk text,
  add column if not exists review_notes text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists content_sha256 text;

-- Backfill one dynamic legacy KB per account so no existing document is lost.
insert into public.ai_knowledge_bases (
  account_id, name, slug, description, scope, status, default_trust_level
)
select distinct d.account_id,
       'Imported legacy knowledge',
       'imported-legacy',
       'Automatically created by migration 067 for pre-v2 knowledge documents.',
       'shared',
       'active',
       'internal'
from public.ai_knowledge_documents d
where not exists (
  select 1 from public.ai_knowledge_bases b
   where b.account_id = d.account_id and b.slug = 'imported-legacy'
)
on conflict (account_id, slug) do nothing;

update public.ai_knowledge_documents d
   set knowledge_base_id = b.id
  from public.ai_knowledge_bases b
 where d.knowledge_base_id is null
   and b.account_id = d.account_id
   and b.slug = 'imported-legacy';

update public.ai_knowledge_documents
   set source_type = coalesce(source_type, 'manual'),
       lifecycle_status = coalesce(lifecycle_status, 'active'),
       trust_level = coalesce(trust_level, 'internal'),
       injection_risk = coalesce(injection_risk, 'none');

alter table public.ai_knowledge_documents
  alter column knowledge_base_id set not null,
  alter column source_type set default 'manual',
  alter column source_type set not null,
  alter column lifecycle_status set default 'draft',
  alter column lifecycle_status set not null,
  alter column trust_level set default 'internal',
  alter column trust_level set not null,
  alter column injection_risk set default 'none',
  alter column injection_risk set not null;

-- Idempotent constraint installation.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_knowledge_documents_source_type_check') then
    alter table public.ai_knowledge_documents add constraint ai_knowledge_documents_source_type_check
      check (source_type in ('manual', 'upload', 'url', 'api', 'integration'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_knowledge_documents_lifecycle_check') then
    alter table public.ai_knowledge_documents add constraint ai_knowledge_documents_lifecycle_check
      check (lifecycle_status in ('draft', 'reviewed', 'active', 'superseded', 'archived', 'quarantined'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_knowledge_documents_trust_check') then
    alter table public.ai_knowledge_documents add constraint ai_knowledge_documents_trust_check
      check (trust_level in ('admin_verified', 'internal', 'external', 'untrusted'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_knowledge_documents_injection_risk_check') then
    alter table public.ai_knowledge_documents add constraint ai_knowledge_documents_injection_risk_check
      check (injection_risk in ('none', 'suspected', 'high'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_knowledge_documents_effective_window_check') then
    alter table public.ai_knowledge_documents add constraint ai_knowledge_documents_effective_window_check
      check (effective_until is null or effective_from is null or effective_until > effective_from);
  end if;
end $$;

create index if not exists ai_knowledge_documents_base_status_idx
  on public.ai_knowledge_documents(account_id, knowledge_base_id, lifecycle_status);
create index if not exists ai_knowledge_documents_effective_idx
  on public.ai_knowledge_documents(account_id, effective_from, effective_until)
  where lifecycle_status = 'active';

-- Defense in depth: even if a future application bug tries to invent a repo
-- path source, the DB rejects it because only the explicit dynamic source
-- types above are permitted.


-- Documents must belong to a KB from the same account. This also protects
-- service-role ingestion code from accidentally crossing tenant boundaries.
create or replace function public.guard_ai_knowledge_document_tenant()
returns trigger language plpgsql set search_path = public as $$
declare
  v_base_account uuid;
begin
  select account_id into v_base_account
    from public.ai_knowledge_bases where id = new.knowledge_base_id;
  if v_base_account is null or v_base_account is distinct from new.account_id then
    raise exception 'KNOWLEDGE_DOCUMENT_ACCOUNT_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_ai_knowledge_document_tenant on public.ai_knowledge_documents;
create trigger guard_ai_knowledge_document_tenant
before insert or update of account_id, knowledge_base_id on public.ai_knowledge_documents
for each row execute function public.guard_ai_knowledge_document_tenant();

-- Review-state guard. Knowledge content is reference data, but it must still
-- complete a human review lifecycle before becoming runtime-active. Editing
-- reviewed/active content invalidates the prior review automatically.
create or replace function public.guard_ai_knowledge_document_lifecycle()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.content is distinct from old.content then
    if new.lifecycle_status in ('reviewed', 'active') then
      new.lifecycle_status := 'draft';
    end if;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_notes := null;
  end if;

  if new.lifecycle_status = 'reviewed' and old.lifecycle_status is distinct from 'reviewed' then
    if new.injection_risk = 'high' and nullif(btrim(coalesce(new.review_notes, '')), '') is null then
      raise exception 'HIGH_RISK_KNOWLEDGE_REVIEW_NOTES_REQUIRED' using errcode = '23514';
    end if;
    if new.reviewed_by is null or new.reviewed_at is null then
      raise exception 'KNOWLEDGE_REVIEW_METADATA_REQUIRED' using errcode = '23514';
    end if;
  end if;

  if new.lifecycle_status = 'active' and old.lifecycle_status is distinct from 'reviewed' then
    raise exception 'KNOWLEDGE_DOCUMENT_MUST_BE_REVIEWED_BEFORE_ACTIVATION' using errcode = '23514';
  end if;
  if new.lifecycle_status = 'active' and (new.reviewed_by is null or new.reviewed_at is null) then
    raise exception 'KNOWLEDGE_DOCUMENT_REVIEW_REQUIRED' using errcode = '23514';
  end if;

  return new;
end $$;
drop trigger if exists guard_ai_knowledge_document_lifecycle on public.ai_knowledge_documents;
create trigger guard_ai_knowledge_document_lifecycle
before update of content, lifecycle_status, injection_risk, review_notes on public.ai_knowledge_documents
for each row execute function public.guard_ai_knowledge_document_lifecycle();

-- ------------------------------------------------------------
-- 3) Service links. A KB may be general (no rows here) or associated
-- with one/more services. Runtime may use p_service_id to narrow results.
-- ------------------------------------------------------------
create table if not exists public.ai_knowledge_base_services (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  knowledge_base_id uuid not null references public.ai_knowledge_bases(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (knowledge_base_id, service_id)
);
create index if not exists ai_knowledge_base_services_account_service_idx
  on public.ai_knowledge_base_services(account_id, service_id);
alter table public.ai_knowledge_base_services enable row level security;
drop policy if exists ai_knowledge_base_services_select on public.ai_knowledge_base_services;
create policy ai_knowledge_base_services_select on public.ai_knowledge_base_services for select
  using (is_account_member(account_id));
drop policy if exists ai_knowledge_base_services_insert on public.ai_knowledge_base_services;
create policy ai_knowledge_base_services_insert on public.ai_knowledge_base_services for insert
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_knowledge_base_services_delete on public.ai_knowledge_base_services;
create policy ai_knowledge_base_services_delete on public.ai_knowledge_base_services for delete
  using (is_account_member(account_id, 'admin'));


create or replace function public.guard_ai_knowledge_base_service_tenant()
returns trigger language plpgsql set search_path = public as $$
declare
  v_base_account uuid;
  v_service_account uuid;
begin
  select account_id into v_base_account
    from public.ai_knowledge_bases where id = new.knowledge_base_id;
  select account_id into v_service_account
    from public.services where id = new.service_id;
  if v_base_account is null or v_base_account is distinct from new.account_id then
    raise exception 'KNOWLEDGE_BASE_SERVICE_BASE_ACCOUNT_MISMATCH' using errcode = '23514';
  end if;
  if v_service_account is null or v_service_account is distinct from new.account_id then
    raise exception 'KNOWLEDGE_BASE_SERVICE_SERVICE_ACCOUNT_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_ai_knowledge_base_service_tenant on public.ai_knowledge_base_services;
create trigger guard_ai_knowledge_base_service_tenant
before insert or update on public.ai_knowledge_base_services
for each row execute function public.guard_ai_knowledge_base_service_tenant();

-- ------------------------------------------------------------
-- 4) Revision -> KB assignment. This supersedes chunk-level assignment.
-- No assignment means NO retrieval: fail closed, no whole-account fallback.
-- ------------------------------------------------------------
create table if not exists public.ai_agent_knowledge_base_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_revision_id uuid not null references public.ai_agent_revisions(id) on delete cascade,
  knowledge_base_id uuid not null references public.ai_knowledge_bases(id) on delete cascade,
  priority integer not null default 100 check (priority between 0 and 1000),
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agent_revision_id, knowledge_base_id)
);
create index if not exists ai_agent_kb_assignments_account_revision_idx
  on public.ai_agent_knowledge_base_assignments(account_id, agent_revision_id);
alter table public.ai_agent_knowledge_base_assignments enable row level security;
drop policy if exists ai_agent_kb_assignments_select on public.ai_agent_knowledge_base_assignments;
create policy ai_agent_kb_assignments_select on public.ai_agent_knowledge_base_assignments for select
  using (is_account_member(account_id));
drop policy if exists ai_agent_kb_assignments_insert on public.ai_agent_knowledge_base_assignments;
create policy ai_agent_kb_assignments_insert on public.ai_agent_knowledge_base_assignments for insert
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_agent_kb_assignments_update on public.ai_agent_knowledge_base_assignments;
create policy ai_agent_kb_assignments_update on public.ai_agent_knowledge_base_assignments for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_agent_kb_assignments_delete on public.ai_agent_knowledge_base_assignments;
create policy ai_agent_kb_assignments_delete on public.ai_agent_knowledge_base_assignments for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.guard_ai_agent_kb_assignment_draft()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_revision_id uuid;
  v_status text;
  v_account uuid;
  v_revision_agent uuid;
  v_base_account uuid;
  v_base_scope text;
  v_base_owner_agent uuid;
begin
  if tg_op = 'DELETE' then
    v_revision_id := old.agent_revision_id;
  else
    v_revision_id := new.agent_revision_id;
  end if;
  select status, account_id, agent_id into v_status, v_account, v_revision_agent
    from public.ai_agent_revisions where id = v_revision_id;
  if v_status is distinct from 'draft' then
    raise exception 'KNOWLEDGE_ASSIGNMENTS_IMMUTABLE_AFTER_PUBLISH' using errcode = 'P0001';
  end if;
  if tg_op <> 'DELETE' then
    if new.account_id is distinct from v_account then
      raise exception 'KNOWLEDGE_ASSIGNMENT_ACCOUNT_MISMATCH' using errcode = '23514';
    end if;
    select account_id, scope, owner_agent_id
      into v_base_account, v_base_scope, v_base_owner_agent
      from public.ai_knowledge_bases where id = new.knowledge_base_id;
    if v_base_account is null or v_base_account is distinct from new.account_id then
      raise exception 'KNOWLEDGE_ASSIGNMENT_BASE_ACCOUNT_MISMATCH' using errcode = '23514';
    end if;
    if v_base_scope = 'agent_private' and v_base_owner_agent is distinct from v_revision_agent then
      raise exception 'PRIVATE_KNOWLEDGE_BASE_WRONG_AGENT' using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Legacy migration: if a revision had chunk assignments, promote the base(s)
-- containing those chunks. If it had none (old runtime meant "whole account"),
-- assign the Imported Legacy KB so behavior remains explicit after upgrade.
insert into public.ai_agent_knowledge_base_assignments (
  account_id, agent_revision_id, knowledge_base_id, priority, enabled
)
select distinct a.account_id, a.agent_revision_id, d.knowledge_base_id,
       min(a.priority) over (partition by a.agent_revision_id, d.knowledge_base_id), true
from public.ai_agent_knowledge_assignments a
join public.ai_knowledge_chunks c on c.id = a.knowledge_chunk_id
join public.ai_knowledge_documents d on d.id = c.document_id
where a.enabled = true
on conflict (agent_revision_id, knowledge_base_id) do nothing;

insert into public.ai_agent_knowledge_base_assignments (
  account_id, agent_revision_id, knowledge_base_id, priority, enabled
)
select r.account_id, r.id, b.id, 100, true
from public.ai_agent_revisions r
join public.ai_knowledge_bases b
  on b.account_id = r.account_id and b.slug = 'imported-legacy'
where not exists (
  select 1 from public.ai_agent_knowledge_base_assignments x
   where x.agent_revision_id = r.id
)
on conflict (agent_revision_id, knowledge_base_id) do nothing;

comment on table public.ai_agent_knowledge_assignments is
  'DEPRECATED by migration 067. Runtime v2 assigns whole knowledge bases through ai_agent_knowledge_base_assignments.';

-- Install immutability only after migration backfill; published historical
-- revisions may be backfilled above, but application-time edits remain draft-only.
drop trigger if exists guard_ai_agent_kb_assignment_draft on public.ai_agent_knowledge_base_assignments;
create trigger guard_ai_agent_kb_assignment_draft
before insert or update or delete on public.ai_agent_knowledge_base_assignments
for each row execute function public.guard_ai_agent_kb_assignment_draft();

-- ------------------------------------------------------------
-- 5) Hybrid retrieval scoped in SQL by account + revision assignment.
-- Model input never contains a knowledge_base_id selector.
-- ------------------------------------------------------------
create or replace function public.match_ai_knowledge_v2_fts(
  p_account_id uuid,
  p_agent_revision_id uuid,
  p_query text,
  p_match_count integer,
  p_service_id uuid default null,
  p_language text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  knowledge_base_id uuid,
  knowledge_base_name text,
  document_title text,
  content text,
  trust_level text,
  source_type text,
  language text,
  updated_at timestamptz,
  rank real
)
language plpgsql stable security invoker set search_path = public as $$
declare
  v_clean text := nullif(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  v_tsq tsquery;
begin
  if v_clean is null or greatest(coalesce(p_match_count, 0), 0) = 0 then return; end if;
  begin
    v_tsq := websearch_to_tsquery('simple', v_clean);
  exception when others then
    v_tsq := plainto_tsquery('simple', v_clean);
  end;
  if v_tsq is null or numnode(v_tsq) = 0 then return; end if;

  return query
  select c.id, d.id, b.id, b.name, d.title, c.content,
         d.trust_level, d.source_type, d.language, d.updated_at,
         ts_rank_cd(c.fts, v_tsq)::real
    from public.ai_agent_knowledge_base_assignments a
    join public.ai_agent_revisions r
      on r.id = a.agent_revision_id and r.account_id = a.account_id
    join public.ai_knowledge_bases b
      on b.id = a.knowledge_base_id and b.account_id = a.account_id
    join public.ai_knowledge_documents d
      on d.knowledge_base_id = b.id and d.account_id = b.account_id
    join public.ai_knowledge_chunks c
      on c.document_id = d.id and c.account_id = d.account_id
   where a.account_id = p_account_id
     and a.agent_revision_id = p_agent_revision_id
     and a.enabled = true
     and b.status = 'active'
     and d.lifecycle_status = 'active'
     and (d.effective_from is null or d.effective_from <= now())
     and (d.effective_until is null or d.effective_until > now())
     and (p_language is null or d.language = 'auto' or d.language = p_language)
     and (
       -- General/private KBs (no service links) are always eligible. A
       -- service-linked KB is eligible only when the SERVER resolved the
       -- matching service id; null never widens into all service knowledge.
       not exists (
         select 1 from public.ai_knowledge_base_services s0
          where s0.knowledge_base_id = b.id
       )
       or (
         p_service_id is not null
         and exists (
           select 1 from public.ai_knowledge_base_services s
            where s.knowledge_base_id = b.id
              and s.account_id = p_account_id
              and s.service_id = p_service_id
         )
       )
     )
     and c.fts @@ v_tsq
   order by a.priority asc, ts_rank_cd(c.fts, v_tsq) desc, c.chunk_index asc
   limit least(greatest(p_match_count, 0), 50);
end $$;

create or replace function public.match_ai_knowledge_v2_semantic(
  p_account_id uuid,
  p_agent_revision_id uuid,
  p_query_embedding text,
  p_match_count integer,
  p_embedding_revision text default null,
  p_service_id uuid default null,
  p_language text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  knowledge_base_id uuid,
  knowledge_base_name text,
  document_title text,
  content text,
  trust_level text,
  source_type text,
  language text,
  updated_at timestamptz,
  distance real
)
language sql stable security invoker set search_path = public as $$
  select c.id, d.id, b.id, b.name, d.title, c.content,
         d.trust_level, d.source_type, d.language, d.updated_at,
         (c.embedding <=> p_query_embedding::vector(1536))::real
    from public.ai_agent_knowledge_base_assignments a
    join public.ai_agent_revisions r
      on r.id = a.agent_revision_id and r.account_id = a.account_id
    join public.ai_knowledge_bases b
      on b.id = a.knowledge_base_id and b.account_id = a.account_id
    join public.ai_knowledge_documents d
      on d.knowledge_base_id = b.id and d.account_id = b.account_id
    join public.ai_knowledge_chunks c
      on c.document_id = d.id and c.account_id = d.account_id
   where a.account_id = p_account_id
     and a.agent_revision_id = p_agent_revision_id
     and a.enabled = true
     and b.status = 'active'
     and d.lifecycle_status = 'active'
     and (d.effective_from is null or d.effective_from <= now())
     and (d.effective_until is null or d.effective_until > now())
     and (p_language is null or d.language = 'auto' or d.language = p_language)
     and (
       -- General/private KBs (no service links) are always eligible. A
       -- service-linked KB is eligible only when the SERVER resolved the
       -- matching service id; null never widens into all service knowledge.
       not exists (
         select 1 from public.ai_knowledge_base_services s0
          where s0.knowledge_base_id = b.id
       )
       or (
         p_service_id is not null
         and exists (
           select 1 from public.ai_knowledge_base_services s
            where s.knowledge_base_id = b.id
              and s.account_id = p_account_id
              and s.service_id = p_service_id
         )
       )
     )
     and c.embedding is not null
     and c.embedding_revision is not distinct from p_embedding_revision
   order by a.priority asc,
            c.embedding <=> p_query_embedding::vector(1536)
   limit least(greatest(p_match_count, 0), 50);
$$;

revoke all on function public.match_ai_knowledge_v2_fts(uuid, uuid, text, integer, uuid, text) from public;
grant execute on function public.match_ai_knowledge_v2_fts(uuid, uuid, text, integer, uuid, text)
  to authenticated, service_role;
revoke all on function public.match_ai_knowledge_v2_semantic(uuid, uuid, text, integer, text, uuid, text) from public;
grant execute on function public.match_ai_knowledge_v2_semantic(uuid, uuid, text, integer, text, uuid, text)
  to authenticated, service_role;

-- ------------------------------------------------------------
-- 6) Audit-friendly helper for replacing draft revision assignments.
-- Atomic replacement prevents half-edited assignment sets.
-- ------------------------------------------------------------
create or replace function public.replace_ai_agent_knowledge_base_assignments(
  p_account_id uuid,
  p_agent_revision_id uuid,
  p_assignments jsonb,
  p_actor_user_id uuid
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_status text;
begin
  if not is_account_member(p_account_id, 'admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select status into v_status from public.ai_agent_revisions
   where id = p_agent_revision_id and account_id = p_account_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'REVISION_NOT_DRAFT' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_assignments, '[]'::jsonb)) <> 'array' then
    raise exception 'ASSIGNMENTS_MUST_BE_ARRAY' using errcode = '22023';
  end if;

  delete from public.ai_agent_knowledge_base_assignments
   where account_id = p_account_id and agent_revision_id = p_agent_revision_id;

  insert into public.ai_agent_knowledge_base_assignments (
    account_id, agent_revision_id, knowledge_base_id, priority, enabled, created_by
  )
  select p_account_id,
         p_agent_revision_id,
         (x->>'knowledge_base_id')::uuid,
         coalesce((x->>'priority')::integer, 100),
         coalesce((x->>'enabled')::boolean, true),
         p_actor_user_id
    from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) x
    join public.ai_knowledge_bases b
      on b.id = (x->>'knowledge_base_id')::uuid
     and b.account_id = p_account_id;

  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.replace_ai_agent_knowledge_base_assignments(uuid, uuid, jsonb, uuid) from public;
grant execute on function public.replace_ai_agent_knowledge_base_assignments(uuid, uuid, jsonb, uuid)
  to authenticated, service_role;
