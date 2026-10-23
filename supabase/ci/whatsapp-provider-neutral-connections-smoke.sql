begin;

-- OW-1 provider-neutral WhatsApp schema + tenant/RLS acceptance.
do $schema$
begin
  if to_regclass('public.whatsapp_connections') is null then
    raise exception 'whatsapp_connections is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.whatsapp_connections'::regclass) then
    raise exception 'RLS is not enabled on whatsapp_connections';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='connection_id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='provider')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='provider_message_id') then
    raise exception 'provider-neutral message identity columns are incomplete';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='broadcast_recipients' and column_name='connection_id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='broadcast_recipients' and column_name='provider')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='broadcast_recipients' and column_name='provider_message_id') then
    raise exception 'provider-neutral broadcast identity columns are incomplete';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and tablename='whatsapp_connections' and indexname='idx_whatsapp_connections_meta_account')
     or not exists (select 1 from pg_indexes where schemaname='public' and tablename='whatsapp_connections' and indexname='idx_whatsapp_connections_openwa_account_session')
     or not exists (select 1 from pg_indexes where schemaname='public' and tablename='messages' and indexname='idx_messages_provider_connection_message') then
    raise exception 'OW-1 provider identity indexes are incomplete';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='whatsapp_connections') <> 4 then
    raise exception 'whatsapp_connections must have exactly four OW-1 policies';
  end if;
end
$schema$;

do $fixture$
declare
  v_owner uuid := '00000000-0000-4000-8000-000000000901';
  v_admin uuid := '00000000-0000-4000-8000-000000000902';
  v_agent uuid := '00000000-0000-4000-8000-000000000903';
  v_viewer uuid := '00000000-0000-4000-8000-000000000904';
  v_outsider uuid := '00000000-0000-4000-8000-000000000905';
  v_account uuid;
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (v_owner,'ow1-owner@example.test','{"full_name":"OW1 Owner"}'::jsonb),
    (v_admin,'ow1-admin@example.test','{"full_name":"OW1 Admin"}'::jsonb),
    (v_agent,'ow1-agent@example.test','{"full_name":"OW1 Agent"}'::jsonb),
    (v_viewer,'ow1-viewer@example.test','{"full_name":"OW1 Viewer"}'::jsonb),
    (v_outsider,'ow1-outsider@example.test','{"full_name":"OW1 Outsider"}'::jsonb);

  select account_id into strict v_account from public.profiles where user_id=v_owner;
  update public.profiles set account_id=v_account, account_role='admin' where user_id=v_admin;
  update public.profiles set account_id=v_account, account_role='agent' where user_id=v_agent;
  update public.profiles set account_id=v_account, account_role='viewer' where user_id=v_viewer;
  perform set_config('ow1.account',v_account::text,true);
end
$fixture$;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000901',true);
insert into public.whatsapp_connections(account_id,provider,status,session_id,engine,provider_metadata)
values(current_setting('ow1.account')::uuid,'openwa','waiting_qr','ow1-owner-session','whatsapp-web.js','{"non_secret":"ok"}'::jsonb);

do $$ begin
  if (select count(*) from public.whatsapp_connections where account_id=current_setting('ow1.account')::uuid) <> 1 then
    raise exception 'owner cannot read own WhatsApp connection';
  end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000902',true);
insert into public.whatsapp_connections(account_id,provider,status,session_id,engine)
values(current_setting('ow1.account')::uuid,'openwa','disconnected','ow1-admin-session','baileys');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000904',true);
do $$
declare v_blocked boolean := false;
begin
  if (select count(*) from public.whatsapp_connections where account_id=current_setting('ow1.account')::uuid) <> 2 then
    raise exception 'viewer cannot read own account connection state';
  end if;
  begin
    insert into public.whatsapp_connections(account_id,provider,status,session_id,engine)
    values(current_setting('ow1.account')::uuid,'openwa','disconnected','ow1-viewer-forbidden','baileys');
  exception when insufficient_privilege then v_blocked := true;
             when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'viewer write escaped WhatsApp connection RLS'; end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000903',true);
do $$
declare v_blocked boolean := false;
begin
  begin
    update public.whatsapp_connections set status='ready'
    where account_id=current_setting('ow1.account')::uuid;
    if found then raise exception 'agent update escaped WhatsApp connection RLS'; end if;
  exception when insufficient_privilege then v_blocked := true;
  end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000905',true);
do $$ begin
  if (select count(*) from public.whatsapp_connections where account_id=current_setting('ow1.account')::uuid) <> 0 then
    raise exception 'cross-tenant WhatsApp connection leaked through RLS';
  end if;
end $$;

reset role;

do $$
begin
  if exists (
    select 1 from public.whatsapp_connections
    where provider_metadata ?| array['access_token','verify_token','api_key','session_secret']
  ) then
    raise exception 'provider_metadata contains a forbidden credential key';
  end if;
  raise notice 'OW-1 provider-neutral WhatsApp smoke passed';
end $$;

rollback;
