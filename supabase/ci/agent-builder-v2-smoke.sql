do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000117';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_count integer;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-builder-v2-smoke@example.test',
    '{"full_name":"Agent Builder V2 Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Builder V2 Provider','builder-v2-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'builder-v2-smoke-117','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'builder-v2-agent',
    'Builder V2 Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'draft',
    v_connection,'smoke-model'
  );

  insert into public.ai_agent_revision_capabilities(
    account_id,agent_revision_id,capability,granted_by
  ) values (
    v_account,v_revision,'outreach.pause',v_user
  );

  select capability_count
    into strict v_count
  from public.update_ai_agent_builder_v2_config(
    v_account,
    v_agent,
    v_revision,
    'outbound',
    '{"bindings":[{"taskType":"coverage.sourcing","taskTypeVersion":1}]}'::jsonb,
    '["agent_tasks.read","outreach.start","contacts.target_read","coverage.sourcing"]'::jsonb,
    v_user
  );

  if v_count<>4 then
    raise exception 'builder capability replace count mismatch: %',v_count;
  end if;

  if not exists (
    select 1
    from public.ai_agent_revisions
    where id=v_revision
      and operational_mode='outbound'
      and outreach_policy='{"bindings":[{"taskType":"coverage.sourcing","taskTypeVersion":1}]}'::jsonb
  ) then
    raise exception 'builder configuration was not persisted';
  end if;

  if (
    select count(*)
    from public.ai_agent_revision_capabilities
    where account_id=v_account
      and agent_revision_id=v_revision
  )<>4 then
    raise exception 'builder capabilities were not atomically replaced';
  end if;

  if exists (
    select 1
    from public.ai_agent_revision_capabilities
    where account_id=v_account
      and agent_revision_id=v_revision
      and capability='outreach.pause'
  ) then
    raise exception 'stale capability survived atomic builder save';
  end if;

  begin
    perform public.update_ai_agent_builder_v2_config(
      v_account,
      v_agent,
      v_revision,
      'invalid-mode',
      '{}'::jsonb,
      '[]'::jsonb,
      v_user
    );
    raise exception 'invalid operational mode unexpectedly accepted';
  exception
    when others then
      if sqlerrm<>'AGENT_BUILDER_OPERATIONAL_MODE_INVALID' then
        raise;
      end if;
  end;

  update public.ai_agent_revisions
  set status='published'
  where id=v_revision;

  begin
    perform public.update_ai_agent_builder_v2_config(
      v_account,
      v_agent,
      v_revision,
      'reactive',
      '{"bindings":[]}'::jsonb,
      '[]'::jsonb,
      v_user
    );
    raise exception 'published revision Builder mutation unexpectedly accepted';
  exception
    when others then
      if sqlerrm<>'AGENT_CAPABILITIES_REVISION_NOT_DRAFT' then
        raise;
      end if;
  end;

  if has_function_privilege(
       'anon',
       'public.update_ai_agent_builder_v2_config(uuid,uuid,uuid,text,jsonb,jsonb,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.update_ai_agent_builder_v2_config(uuid,uuid,uuid,text,jsonb,jsonb,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.update_ai_agent_builder_v2_config(uuid,uuid,uuid,text,jsonb,jsonb,uuid)',
       'EXECUTE'
     ) then
    raise exception 'Builder V2 config RPC privileges are unsafe';
  end if;

  delete from public.ai_agent_revision_capabilities where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'agent Builder V2 smoke passed';
end
$$;
