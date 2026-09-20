-- ============================================================
-- 092_business_event_outbox_advisor_cleanup.sql
-- Phase E advisor cleanup for the new business-event outbox.
-- ============================================================

create index if not exists business_event_outbox_contact_idx
  on public.business_event_outbox(contact_id)
  where contact_id is not null;

create index if not exists business_event_outbox_conversation_idx
  on public.business_event_outbox(conversation_id)
  where conversation_id is not null;

create index if not exists business_event_outbox_local_message_idx
  on public.business_event_outbox(local_message_id)
  where local_message_id is not null;

-- The table remains private: only service_role has table privileges. This
-- policy documents the intended RLS owner explicitly; service_role already
-- bypasses RLS, while anon/authenticated still have no table grants.
drop policy if exists business_event_outbox_service_role_all
  on public.business_event_outbox;

create policy business_event_outbox_service_role_all
  on public.business_event_outbox
  for all
  to service_role
  using (true)
  with check (true);
