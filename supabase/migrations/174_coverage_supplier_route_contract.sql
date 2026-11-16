-- Additive Coverage supplier contract: a supplier must explicitly accept
-- the frozen requester/supplier settlement legs before any proposal is made.
-- Existing pending negotiations remain route_confirmed=false; no approval
-- is retroactively inferred from free-text or old "نعم" messages.
ALTER TABLE public.ai_agent_coverage_supplier_negotiations
  ADD COLUMN IF NOT EXISTS route_confirmed boolean NOT NULL DEFAULT false;

ALTER TABLE public.ai_agent_coverage_supplier_negotiations
  DROP CONSTRAINT ai_agent_coverage_supplier_negotiations_stage_check;

ALTER TABLE public.ai_agent_coverage_supplier_negotiations
  ADD CONSTRAINT ai_agent_coverage_supplier_negotiations_stage_check
  CHECK (stage IN (
    'availability', 'route', 'amount', 'commission', 'details',
    'confirmation', 'submitting', 'submitted', 'needs_human', 'declined'
  ));

COMMENT ON COLUMN public.ai_agent_coverage_supplier_negotiations.route_confirmed
 IS 'Explicit structured supplier acknowledgement of the exact frozen Coverage Request direction; old negotiation rows default false. Not inferred from prose or agent output.';
