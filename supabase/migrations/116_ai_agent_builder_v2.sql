-- ============================================================
-- 116_ai_agent_builder_v2.sql
-- Phase 10: freeze outbound Builder configuration on Agent Revisions.
-- Additive only; existing revisions remain reactive by default.
-- ============================================================

alter table public.ai_agent_revisions
  add column if not exists operational_mode text not null default 'reactive',
  add column if not exists outreach_policy jsonb not null default '{}'::jsonb;

alter table public.ai_agent_revisions
  drop constraint if exists ai_agent_revisions_operational_mode_check;

alter table public.ai_agent_revisions
  add constraint ai_agent_revisions_operational_mode_check
  check (operational_mode in ('reactive','outbound','both'));

alter table public.ai_agent_revisions
  drop constraint if exists ai_agent_revisions_outreach_policy_object_check;

alter table public.ai_agent_revisions
  add constraint ai_agent_revisions_outreach_policy_object_check
  check (jsonb_typeof(outreach_policy) = 'object');

comment on column public.ai_agent_revisions.operational_mode is
  'Builder V2 operational intent. This is not a permission; runtime capability/tool policy remains authoritative.';

comment on column public.ai_agent_revisions.outreach_policy is
  'Frozen Builder V2 task-type, target-scope, limits, approval and simulation configuration for this revision.';
