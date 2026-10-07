-- Phase 6 / NOTE-004: make Agent Run table privileges deterministic.
--
-- RLS remains the row-level authority. This migration normalizes the
-- table-level ACL so clean databases and long-lived TEST databases
-- expose the same client surface instead of inheriting historical
-- default privileges.

revoke all on table public.ai_agent_runs from anon, authenticated;
grant select, update on table public.ai_agent_runs to authenticated;
grant select, insert, update, delete on table public.ai_agent_runs to service_role;

revoke all on table public.ai_agent_run_events from anon, authenticated;
grant select on table public.ai_agent_run_events to authenticated;
grant select, insert, update, delete on table public.ai_agent_run_events to service_role;
