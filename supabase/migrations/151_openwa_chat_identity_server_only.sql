-- Provider-native OpenWA chat JIDs are supplied by signed server-side webhook
-- intake, never by a browser/API actor. Protect routing integrity from client
-- INSERT/UPDATE even if the caller is an authorized CRM agent.
CREATE FUNCTION public.enforce_openwa_chat_identity_write_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_chat_id IS NOT NULL THEN
      RAISE EXCEPTION 'OpenWA provider chat identity is server-managed'
        USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.provider_chat_id IS DISTINCT FROM OLD.provider_chat_id
      OR (
        OLD.provider_chat_id IS NOT NULL
        AND (
          NEW.provider IS DISTINCT FROM OLD.provider
          OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
          OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
          OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
        )
      )
    THEN
      RAISE EXCEPTION 'OpenWA provider chat identity is server-managed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions should not be directly callable by public Data API roles.
REVOKE ALL ON FUNCTION public.enforce_openwa_chat_identity_write_boundary() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_openwa_chat_identity_server_only ON public.messages;
CREATE TRIGGER messages_openwa_chat_identity_server_only
  BEFORE INSERT OR UPDATE OF provider_chat_id, provider, connection_id,
    conversation_id, sender_type, created_at
  ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_openwa_chat_identity_write_boundary();

COMMENT ON FUNCTION public.enforce_openwa_chat_identity_write_boundary() IS
  'Server-only immutable OpenWA routing JID and connection/conversation binding on inbound messages.';
