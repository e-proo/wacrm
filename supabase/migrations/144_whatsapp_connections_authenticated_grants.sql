-- OW-1 follow-up: table privileges required before row-level policies can apply.
-- Existing RLS policies remain the tenant and role authorization boundary.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_connections TO authenticated;
