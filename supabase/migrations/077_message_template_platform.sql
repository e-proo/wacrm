-- ============================================================
-- 077_message_template_platform.sql
-- Account-owned message-template overrides with immutable revisions and an
-- explicit publication pointer. System defaults remain versioned in code.
-- ============================================================

create table if not exists public.message_template_revisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  template_key text not null,
  audience text not null,
  channel text not null,
  locale text not null default 'ar',
  version integer not null,
  body text not null,
  required_variables text[] not null default '{}',
  optional_variables text[] not null default '{}',
  secret_variables text[] not null default '{}',
  max_length integer null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid null,
  created_at timestamptz not null default now(),

  constraint message_template_key_format_ck
    check (template_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' and length(template_key) <= 160),
  constraint message_template_audience_ck
    check (audience in ('customer', 'admin', 'internal')),
  constraint message_template_channel_ck
    check (channel in ('whatsapp', 'in_app', 'email', 'sms')),
  constraint message_template_locale_ck
    check (locale ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$' and length(locale) <= 32),
  constraint message_template_version_ck check (version > 0),
  constraint message_template_body_ck check (length(body) between 1 and 20000),
  constraint message_template_max_length_ck check (max_length is null or max_length between 1 and 20000),
  constraint message_template_metadata_object_ck check (jsonb_typeof(metadata) = 'object'),
  constraint message_template_revision_identity_uidx
    unique (account_id, template_key, audience, channel, locale, version),
  constraint message_template_revision_account_id_uidx
    unique (account_id, id)
);

create index if not exists message_template_revisions_lookup_idx
  on public.message_template_revisions(account_id, template_key, audience, channel, locale, version desc);

create table if not exists public.message_template_publications (
  account_id uuid not null references public.accounts(id) on delete cascade,
  template_key text not null,
  audience text not null,
  channel text not null,
  locale text not null,
  revision_id uuid not null,
  published_by uuid null,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (account_id, template_key, audience, channel, locale),
  constraint message_template_publication_revision_fk
    foreign key (account_id, revision_id)
    references public.message_template_revisions(account_id, id)
    on delete restrict,
  constraint message_template_publication_key_format_ck
    check (template_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' and length(template_key) <= 160),
  constraint message_template_publication_audience_ck
    check (audience in ('customer', 'admin', 'internal')),
  constraint message_template_publication_channel_ck
    check (channel in ('whatsapp', 'in_app', 'email', 'sms')),
  constraint message_template_publication_locale_ck
    check (locale ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$' and length(locale) <= 32)
);

create index if not exists message_template_publications_revision_idx
  on public.message_template_publications(account_id, revision_id);

alter table public.message_template_revisions enable row level security;
alter table public.message_template_publications enable row level security;

revoke all on table public.message_template_revisions from public, anon, authenticated;
revoke all on table public.message_template_publications from public, anon, authenticated;
grant select on table public.message_template_revisions to authenticated;
grant select on table public.message_template_publications to authenticated;
grant all on table public.message_template_revisions to service_role;
grant all on table public.message_template_publications to service_role;

create policy message_template_revisions_admin_read
  on public.message_template_revisions
  for select
  to authenticated
  using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

create policy message_template_publications_admin_read
  on public.message_template_publications
  for select
  to authenticated
  using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

create or replace function public.create_message_template_revision(
  p_account_id uuid,
  p_template_key text,
  p_audience text,
  p_channel text,
  p_locale text,
  p_body text,
  p_required_variables text[] default '{}',
  p_optional_variables text[] default '{}',
  p_secret_variables text[] default '{}',
  p_max_length integer default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(revision_id uuid, version integer)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_version integer;
  v_revision_id uuid;
begin
  if auth.uid() is not null
     and not public.is_account_member(p_account_id, 'admin'::public.account_role_enum) then
    raise exception 'MESSAGE_TEMPLATE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_account_id::text),
    hashtext(concat_ws('|', p_template_key, p_audience, p_channel, p_locale))
  );

  select coalesce(max(mtr.version), 0) + 1
    into v_version
    from public.message_template_revisions as mtr
   where mtr.account_id = p_account_id
     and mtr.template_key = p_template_key
     and mtr.audience = p_audience
     and mtr.channel = p_channel
     and mtr.locale = p_locale;

  insert into public.message_template_revisions(
    account_id,
    template_key,
    audience,
    channel,
    locale,
    version,
    body,
    required_variables,
    optional_variables,
    secret_variables,
    max_length,
    metadata,
    created_by
  ) values (
    p_account_id,
    p_template_key,
    p_audience,
    p_channel,
    p_locale,
    v_version,
    p_body,
    coalesce(p_required_variables, '{}'),
    coalesce(p_optional_variables, '{}'),
    coalesce(p_secret_variables, '{}'),
    p_max_length,
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  )
  returning message_template_revisions.id into v_revision_id;

  revision_id := v_revision_id;
  version := v_version;
  return next;
end;
$$;

create or replace function public.publish_message_template_revision(
  p_account_id uuid,
  p_revision_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_revision public.message_template_revisions%rowtype;
begin
  if auth.uid() is not null
     and not public.is_account_member(p_account_id, 'admin'::public.account_role_enum) then
    raise exception 'MESSAGE_TEMPLATE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select mtr.*
    into v_revision
    from public.message_template_revisions as mtr
   where mtr.account_id = p_account_id
     and mtr.id = p_revision_id;

  if not found then
    raise exception 'MESSAGE_TEMPLATE_REVISION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.message_template_publications(
    account_id,
    template_key,
    audience,
    channel,
    locale,
    revision_id,
    published_by,
    published_at,
    updated_at
  ) values (
    p_account_id,
    v_revision.template_key,
    v_revision.audience,
    v_revision.channel,
    v_revision.locale,
    v_revision.id,
    auth.uid(),
    now(),
    now()
  )
  on conflict (account_id, template_key, audience, channel, locale)
  do update set
    revision_id = excluded.revision_id,
    published_by = excluded.published_by,
    published_at = now(),
    updated_at = now();

  return v_revision.id;
end;
$$;

create or replace function public.unpublish_message_template(
  p_account_id uuid,
  p_template_key text,
  p_audience text,
  p_channel text,
  p_locale text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is not null
     and not public.is_account_member(p_account_id, 'admin'::public.account_role_enum) then
    raise exception 'MESSAGE_TEMPLATE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  delete from public.message_template_publications as mtp
   where mtp.account_id = p_account_id
     and mtp.template_key = p_template_key
     and mtp.audience = p_audience
     and mtp.channel = p_channel
     and mtp.locale = p_locale;

  return found;
end;
$$;

revoke execute on function public.create_message_template_revision(
  uuid, text, text, text, text, text, text[], text[], text[], integer, jsonb
) from public, anon;
grant execute on function public.create_message_template_revision(
  uuid, text, text, text, text, text, text[], text[], text[], integer, jsonb
) to authenticated, service_role;

revoke execute on function public.publish_message_template_revision(uuid, uuid)
  from public, anon;
grant execute on function public.publish_message_template_revision(uuid, uuid)
  to authenticated, service_role;

revoke execute on function public.unpublish_message_template(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.unpublish_message_template(uuid, text, text, text, text)
  to authenticated, service_role;
