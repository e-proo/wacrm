-- NOTE-001 | Supabase Security Advisor 0028. TEST/STAGING additive ACL hardening.
-- 252 RLS policies on the audited database reference is_account_member().
-- Retain that public function as a non-privileged entrypoint, even for anon,
-- while protecting the actual privileged membership read in a private schema.
-- Pair this migration with the server-side invitation peek route change.

create schema if not exists wacrm_internal;
revoke all on schema wacrm_internal from public, anon;
grant usage on schema wacrm_internal to authenticated, service_role;

create or replace function wacrm_internal.is_account_member_checked(
  target_account_id uuid,
  min_role public.account_role_enum default 'viewer'::public.account_role_enum
)
returns boolean language sql stable security definer set search_path = ''
as $helper$
  select exists (
    select 1 from public.profiles p
     where p.user_id = (select auth.uid())
       and p.account_id = target_account_id
       and case p.account_role
         when 'owner' then 4 when 'admin' then 3
         when 'agent' then 2 when 'viewer' then 1
       end >= case min_role
         when 'owner' then 4 when 'admin' then 3
         when 'agent' then 2 when 'viewer' then 1
       end
  );
$helper$;
revoke execute on function wacrm_internal.is_account_member_checked(uuid, public.account_role_enum)
  from public, anon, authenticated;
grant execute on function wacrm_internal.is_account_member_checked(uuid, public.account_role_enum)
  to authenticated, service_role;

create or replace function public.is_account_member(
  target_account_id uuid,
  min_role public.account_role_enum default 'viewer'::public.account_role_enum
)
returns boolean language plpgsql stable security invoker set search_path = ''
as $wrapper$
begin
  -- Avoid permission errors in anonymous reads of existing PUBLIC RLS policies.
  if auth.uid() is null then return false; end if;
  return wacrm_internal.is_account_member_checked(target_account_id, min_role);
end;
$wrapper$;
grant execute on function public.is_account_member(uuid, public.account_role_enum)
  to anon, authenticated, service_role;

-- Explicit, audited inventory. Abort atomically on missing/overloaded targets.
do $acl$
declare r record; touched integer := 0;
begin
  for r in
    select p.oid, p.proname, p.prosecdef
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname=any(array['_bcast_bump', 'broadcast_recipient_aggregate_trigger', 'handle_new_user', 'match_ai_knowledge_semantic', 'merge_duplicate_contacts', 'merge_duplicate_conversations', 'notify_conversation_assigned', 'peek_invitation', 'recompute_broadcast_counts', 'record_webhook_failure', 'redeem_invitation', 'release_coverage_match', 'remove_account_member', 'reserve_coverage_match', 'rls_auto_enable', 'seed_default_coverage_regions_for_account', 'seed_default_coverage_service_for_account', 'seed_default_currencies_for_account', 'set_member_role', 'touch_presence', 'transfer_account_ownership']::text[])
  loop
    if not r.prosecdef then
      raise exception 'Expected SECURITY DEFINER: %', r.proname;
    end if;
    -- Revoke PUBLIC as well: anon inherits PUBLIC's function EXECUTE.
    execute format('revoke execute on function %s from public, anon, authenticated',r.oid::regprocedure);
    execute format('grant execute on function %s to service_role',r.oid::regprocedure);
    touched:=touched+1;
  end loop;
  if touched<>21 then
    raise exception 'Expected 21 known DEFN routines, got %',touched;
  end if;
end;
$acl$;

-- Existing business RPCs check auth.uid() and caller's membership/role.
grant execute on function public.redeem_invitation(text) to authenticated;
grant execute on function public.remove_account_member(uuid) to authenticated;
grant execute on function public.set_member_role(uuid,public.account_role_enum) to authenticated;
grant execute on function public.touch_presence(text) to authenticated;
grant execute on function public.transfer_account_ownership(uuid) to authenticated;

-- peek_invitation(text) is now service-role-only. The public Next.js peek
-- endpoint hashes the token and invokes this RPC via the server admin client.
