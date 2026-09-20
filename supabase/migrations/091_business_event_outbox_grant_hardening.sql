-- ============================================================
-- 091_business_event_outbox_grant_hardening.sql
-- Tighten the Phase E outbox privileges after migration 090.
--
-- Some Supabase projects still carry broad default privileges for service_role
-- on newly-created public tables. The outbox runtime needs CRUD only; it does
-- not need TRUNCATE, TRIGGER, or REFERENCES.
-- ============================================================

revoke all on table public.business_event_outbox
  from public, anon, authenticated, service_role;

grant select, insert, update, delete
  on table public.business_event_outbox
  to service_role;
