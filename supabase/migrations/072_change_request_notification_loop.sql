-- ============================================================
-- 072_change_request_notification_loop.sql
-- Durable operator notification metadata for AI-created change requests.
--
-- Plaintext approval PINs are intentionally NOT persisted here. The existing
-- change_requests table keeps only the hash; the runtime may deliver the
-- one-time PIN directly to a verified trusted-admin WhatsApp identity.
-- ============================================================

alter table public.notifications
  add column if not exists change_request_id uuid
    references public.change_requests(id) on delete cascade,
  add column if not exists dedupe_key text;

-- Migration 027 originally allowed only conversation_assigned. Change-request
-- approval alerts are system notifications to a specific linked admin member.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('conversation_assigned', 'change_request_pending'));

-- A regular UNIQUE index is intentional: PostgreSQL already permits multiple
-- NULL values, and PostgREST/Supabase can infer this index for
-- upsert(..., { onConflict: 'dedupe_key' }). A partial unique index would not
-- be inferred by that ON CONFLICT target.
create unique index if not exists notifications_dedupe_key_uidx
  on public.notifications(dedupe_key);

create index if not exists notifications_change_request_idx
  on public.notifications(account_id, change_request_id, created_at desc)
  where change_request_id is not null;

comment on column public.notifications.change_request_id is
  'Optional durable link to a pending change request. Approval PINs are never stored in notifications.';

comment on column public.notifications.dedupe_key is
  'Server-owned idempotency key for non-conversation system notifications.';
