-- OW14-W05 follow-up: Supabase default service_role table privileges
-- grant UPDATE/DELETE/TRUNCATE on new tables. The disposition audit must be
-- append-only even for service-role application traffic.
REVOKE ALL ON public.openwa_ack_disposition_audit FROM service_role;
GRANT SELECT,INSERT ON public.openwa_ack_disposition_audit TO service_role;
COMMENT ON TABLE public.openwa_ack_disposition_audit IS
  'PII-minimal append-only audit: service_role SELECT/INSERT only. No status assertion or resend authorization.';
