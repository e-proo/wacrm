-- Shared local-only account fixture for Phase 14-17 smokes that exercise
-- an existing TEST-like account without creating their own auth identity.
--
-- The GitHub Migrations job runs against an ephemeral local Supabase database.
-- This row is never applied as a migration and never touches hosted TEST/PROD.
insert into auth.users (id,email,raw_user_meta_data)
values (
  '00000000-0000-4000-8000-000000001417',
  'agent-task-shared-smoke@example.test',
  '{"full_name":"Agent Task Shared Smoke"}'::jsonb
)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from public.profiles
    where user_id='00000000-0000-4000-8000-000000001417'::uuid
  ) then
    raise exception 'AGENT_TASK_SHARED_SMOKE_PROFILE_MISSING';
  end if;
end
$$;
