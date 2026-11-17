-- Supplier quotes may be explicit counteroffers: preserve their divergence
-- separately from route_confirmed so a manually reviewed quote never appears
-- to be an exact match to the source Coverage Request.
ALTER TABLE public.ai_agent_coverage_supplier_negotiations
  ADD COLUMN IF NOT EXISTS route_different boolean NOT NULL DEFAULT false;

ALTER TABLE public.ai_agent_coverage_supplier_negotiations
  ADD CONSTRAINT ai_agent_coverage_supplier_route_exclusive
  CHECK (NOT (route_confirmed AND route_different));

COMMENT ON COLUMN public.ai_agent_coverage_supplier_negotiations.route_different
  IS 'Supplier explicitly offered alternate terms/route; show the discrepancy to admin, never create a matching offer or fulfill the original request automatically.';
