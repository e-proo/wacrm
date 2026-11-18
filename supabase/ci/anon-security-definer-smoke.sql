-- NOTE-001. Rolled-back regression for Supabase Security Advisor 0028.
-- Run AFTER the clean replay, never against Production.
begin;

do $acl_assert$
declare
  r record;
  flagged integer;
  inspected integer:=0;
begin
  select count(*) into flagged
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef
     and has_function_privilege('anon',p.oid,'EXECUTE');
  if flagged<>0 then
    raise exception 'Anonymous SECURITY DEFINER RPC count must be zero, got %',flagged;
  end if;

  if (select prosecdef from pg_proc
      where oid='public.is_account_member(uuid,public.account_role_enum)'::regprocedure) then
    raise exception 'Public RLS membership helper must be SECURITY INVOKER';
  end if;

  if not (select prosecdef from pg_proc
      where oid='wacrm_internal.is_account_member_checked(uuid,public.account_role_enum)'::regprocedure) then
    raise exception 'Private membership helper must be SECURITY DEFINER';
  end if;

  if has_schema_privilege('anon','wacrm_internal','USAGE')
     or has_function_privilege('anon',
       'wacrm_internal.is_account_member_checked(uuid,public.account_role_enum)','EXECUTE') then
    raise exception 'Anonymous role can reach private membership helper';
  end if;

  if not has_function_privilege('anon',
       'public.is_account_member(uuid,public.account_role_enum)','EXECUTE') then
    raise exception 'Anonymous RLS cannot call safe invoker wrapper';
  end if;

  for r in
    select p.oid, p.proname from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname=any(array['_bcast_bump', 'broadcast_recipient_aggregate_trigger', 'handle_new_user', 'match_ai_knowledge_semantic', 'merge_duplicate_contacts', 'merge_duplicate_conversations', 'notify_conversation_assigned', 'peek_invitation', 'recompute_broadcast_counts', 'record_webhook_failure', 'redeem_invitation', 'release_coverage_match', 'remove_account_member', 'reserve_coverage_match', 'rls_auto_enable', 'seed_default_coverage_regions_for_account', 'seed_default_coverage_service_for_account', 'seed_default_currencies_for_account', 'set_member_role', 'touch_presence', 'transfer_account_ownership']::text[])
  loop
    if has_function_privilege('anon',r.oid,'EXECUTE') then
      raise exception 'Anon RPC remains callable: %',r.proname;
    end if;
    if not has_function_privilege('service_role',r.oid,'EXECUTE') then
      raise exception 'Server RPC lost EXECUTE: %',r.proname;
    end if;
    if r.proname=any(array[
      'peek_invitation','match_ai_knowledge_semantic','merge_duplicate_contacts',
      'merge_duplicate_conversations','reserve_coverage_match','release_coverage_match',
      'record_webhook_failure','recompute_broadcast_counts','seed_default_currencies_for_account'
    ]::text[])
       and has_function_privilege('authenticated',r.oid,'EXECUTE') then
      raise exception 'Privileged unscoped function remains authenticated-callable: %',r.proname;
    end if;
    inspected:=inspected+1;
  end loop;
  if inspected<>21 then raise exception 'Expected 21 restricted functions, got %',inspected; end if;

  if not has_function_privilege('authenticated','public.redeem_invitation(text)','EXECUTE')
      or not has_function_privilege('authenticated','public.touch_presence(text)','EXECUTE')
      or not has_function_privilege('authenticated','public.set_member_role(uuid,public.account_role_enum)','EXECUTE')
      or not has_function_privilege('authenticated','public.remove_account_member(uuid)','EXECUTE')
      or not has_function_privilege('authenticated','public.transfer_account_ownership(uuid)','EXECUTE') then
    raise exception 'Authenticated member-management RPC compatibility broken';
  end if;
end;
$acl_assert$;

-- A new account/profile is still provisioned by auth.users INSERT triggers,
-- which do NOT need direct user EXECUTE rights on their trigger routines.
do $fixture$
declare v_user uuid:=gen_random_uuid(); v_account uuid;
begin
  insert into auth.users (id,email,raw_user_meta_data)
  values (v_user,'acl-test-'||v_user::text||'@example.test','{"full_name":"ACL test"}'::jsonb);
  select account_id into v_account from public.profiles where user_id=v_user;
  if v_account is null then raise exception 'Signup trigger failed after ACL revocation'; end if;
  if not exists (select 1 from public.accounts where id=v_account and owner_user_id=v_user) then
    raise exception 'Signup account bootstrap failed after ACL revocation';
  end if;
  perform set_config('acl_test.uid',v_user::text,true);
  perform set_config('acl_test.account',v_account::text,true);
end;
$fixture$;

set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('acl_test.uid'),true);

do $auth$
begin
  if not public.is_account_member(current_setting('acl_test.account')::uuid,'viewer')
    or not public.is_account_member(current_setting('acl_test.account')::uuid,'owner') then
    raise exception 'Signed-in owner lost RLS membership access';
  end if;
  if public.is_account_member(gen_random_uuid(),'viewer') then
    raise exception 'Membership wrapper accepted a different account';
  end if;
end;
$auth$;

reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);

do $anon$
begin
  if public.is_account_member(current_setting('acl_test.account')::uuid,'viewer') then
    raise exception 'Anonymous user gained account membership';
  end if;
  -- Existing public RLS policies must quietly deny rows, not throw 42501.
  if (select count(*) from public.accounts)>0 then
    raise exception 'Anon can read tenant accounts';
  end if;
  if (select count(*) from public.profiles)>0 then
    raise exception 'Anon can read tenant profiles';
  end if;
  if (select count(*) from public.account_invitations)>0 then
    raise exception 'Anon can read invitations';
  end if;
end;
$anon$;
reset role;

rollback;
