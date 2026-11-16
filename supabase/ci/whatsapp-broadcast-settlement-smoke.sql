-- OW unified broadcast: the reconciliation state is additive and does not widen grants.
DO $$
DECLARE constraint_sql text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_sql
  FROM pg_constraint
  WHERE conrelid = 'public.broadcast_recipients'::regclass
    AND conname = 'broadcast_recipients_status_check';
  IF constraint_sql IS NULL OR
     position('sending' in constraint_sql) = 0 OR
     position('requires_reconciliation' in constraint_sql) = 0 THEN
    RAISE EXCEPTION 'Broadcast recipient durable settlement statuses missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND tablename = 'broadcast_recipients'
      AND indexname = 'idx_broadcast_recipients_unsettled'
  ) THEN
    RAISE EXCEPTION 'Broadcast unsettled-status index missing';
  END IF;
END $$;
