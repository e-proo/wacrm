-- Freeze the recipient identity when the campaign first enters the durable queue.
-- Editing a CRM contact later must never redirect an already-approved campaign.
ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS recipient_phone_snapshot text;
COMMENT ON COLUMN public.broadcast_recipients.recipient_phone_snapshot IS
  'Digits-only provider recipient address, permanently pinned when the campaign is first enqueued. Not recalculated on resume.';

CREATE OR REPLACE FUNCTION public.freeze_broadcast_recipients_at_enqueue()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  -- Only missing snapshots are written: even deliberate resume cannot silently
  -- change the recipient to another CRM contact phone after planning.
  UPDATE public.broadcast_recipients r
     SET recipient_phone_snapshot=regexp_replace(c.phone,'[^0-9]','','g')
    FROM public.contacts c
   WHERE r.broadcast_id=NEW.broadcast_id
     AND r.contact_id=c.id
     AND c.account_id=NEW.account_id
     AND r.recipient_phone_snapshot IS NULL;
  IF EXISTS (
    SELECT 1 FROM public.broadcast_recipients r
    WHERE r.broadcast_id=NEW.broadcast_id
      AND (r.recipient_phone_snapshot IS NULL OR
           r.recipient_phone_snapshot !~ '^[1-9][0-9]{6,14}$')
  ) THEN
    RAISE EXCEPTION 'Campaign contains unresolvable recipient phone snapshots'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.freeze_broadcast_recipients_at_enqueue() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS broadcast_recipient_freeze_on_queue ON public.broadcast_delivery_jobs;
CREATE TRIGGER broadcast_recipient_freeze_on_queue
BEFORE INSERT OR UPDATE OF state ON public.broadcast_delivery_jobs
FOR EACH ROW WHEN (NEW.state='queued')
EXECUTE FUNCTION public.freeze_broadcast_recipients_at_enqueue();
