-- SOF-17 SP-2/3: prevent concurrent promotion Tasks for the same service.
-- This is an additive unique index; no old migration is altered.
-- Service Promotion audience is frozen in task_context and belongs to an
-- account. Cross-worker/current-branch races must fail safely even when
-- the JS preflight sees no active Task yet.
--
-- Important: a Production rollout must check for preexisting duplicate
-- active promotion Tasks BEFORE applying this index. TEST is the target.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_tasks_one_active_promotion_service_uidx
  ON public.ai_agent_tasks (account_id, (task_context ->> 'serviceId'))
  WHERE task_type = 'services.promotion'
    AND status IN ('validating', 'scheduled', 'queued', 'running', 'paused')
    AND task_context ? 'serviceId';

COMMENT ON INDEX public.ai_agent_tasks_one_active_promotion_service_uidx IS
  'SOF-17: one active promotion per account+service, across V1/V2 and racing operators';
