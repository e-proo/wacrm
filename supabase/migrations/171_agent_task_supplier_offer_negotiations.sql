-- SOF-66 — durable, per-target supplier negotiation for Coverage Agent Tasks.
-- Does NOT edit existing schema/data or send WhatsApp messages.
-- Only the server-side correlated Task reply may advance this record.
CREATE TABLE public.ai_agent_coverage_supplier_negotiations (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.ai_agent_tasks(id) ON DELETE CASCADE,
  task_target_id uuid NOT NULL REFERENCES public.ai_agent_task_targets(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'availability'
    CONSTRAINT ai_agent_coverage_supplier_negotiations_stage_check
    CHECK (stage IN ('availability','amount','commission','details','confirmation',
      'submitting','submitted','needs_human','declined')),
  offered_amount numeric(18,4)
    CONSTRAINT ai_agent_coverage_supplier_negotiations_amount_check
    CHECK (offered_amount IS NULL OR offered_amount>0),
  commission_per_thousand numeric(18,4)
    CONSTRAINT ai_agent_coverage_supplier_negotiations_commission_check
    CHECK (commission_per_thousand IS NULL OR
      (commission_per_thousand>=0 AND commission_per_thousand<=1000)),
  supplier_details text
    CONSTRAINT ai_agent_coverage_supplier_negotiations_details_check
    CHECK (supplier_details IS NULL OR length(supplier_details)<=800),
  confirmation_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  confirmation_run_id uuid REFERENCES public.ai_agent_runs(id) ON DELETE SET NULL,
  change_request_id uuid REFERENCES public.change_requests(id) ON DELETE SET NULL,
  last_inbound_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 0
    CONSTRAINT ai_agent_coverage_supplier_negotiations_version_check
    CHECK (version>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id,task_id,task_target_id)
);
CREATE INDEX ai_agent_coverage_supplier_negotiations_pending_idx
  ON public.ai_agent_coverage_supplier_negotiations(account_id,stage,updated_at DESC);
CREATE INDEX ai_agent_coverage_supplier_negotiations_cr_idx
  ON public.ai_agent_coverage_supplier_negotiations(account_id,change_request_id)
  WHERE change_request_id IS NOT NULL;

ALTER TABLE public.ai_agent_coverage_supplier_negotiations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_agent_coverage_supplier_negotiations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_agent_coverage_supplier_negotiations TO service_role;

COMMENT ON TABLE public.ai_agent_coverage_supplier_negotiations IS
  'One server-verified, CAS-protected negotiation per frozen Coverage Task target. A supplier confirmation creates an audited administrative proposal, never an automatic coverage offer. All contact/Task lookups are tenant-scoped.';
