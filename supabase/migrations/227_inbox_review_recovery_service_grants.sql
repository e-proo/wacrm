-- FIX-03 clean-replay parity: migration 226 uses SECURITY INVOKER and explicit
-- tenant/actor/evidence fences. Hosted TEST already has these service privileges;
-- clean CI requires them explicitly for source recovery and row locks.
-- No browser grants, no RLS/policy change, no SECURITY DEFINER escalation.
GRANT UPDATE(last_message_at,last_message_text,updated_at) ON public.conversations TO service_role;
-- FOR SHARE requires at least one UPDATE-column privilege; no contact data
-- or message identity column is writable by these grants.
GRANT UPDATE(updated_at) ON public.contacts TO service_role;
GRANT UPDATE(status) ON public.messages TO service_role;
GRANT INSERT(conversation_id,sender_type,content_type,content_text,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at)
 ON public.messages TO service_role;
