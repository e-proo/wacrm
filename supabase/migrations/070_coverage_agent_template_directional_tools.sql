-- ============================================================
-- 070_coverage_agent_template_directional_tools.sql
-- Align future agent-builder templates with canonical coverage behavior.
--
-- Customer coverage agent can now complete the whole customer-side flow:
--   1) resolve direction + quote current published commission,
--   2) inspect matching supply when direction is a REQUEST,
--   3) forward the confirmed canonical OFFER or REQUEST for approval.
--
-- No direct authoritative write is introduced: propose_* remains an approval
-- proposal, bound to the current customer conversation by the server.
-- ============================================================

update public.ai_agent_templates
   set description =
         'End-to-end customer coverage: resolves customer pay/receive direction, quotes the current published commission, checks matching supply, and forwards confirmed offers/requests through approval.',
       suggested_tool_keys =
         (suggested_tool_keys
            - 'coverage.get_rates'
            - 'coverage.find_offers'
            - 'coverage.propose_offer'
            - 'coverage.propose_request')
         || '["coverage.get_rates","coverage.find_offers","coverage.propose_offer","coverage.propose_request"]'::jsonb
 where system_template_key = 'coverage';

-- Admin operations should read operational coverage data and pending changes.
-- Customer-bound proposal tools are deliberately removed from this template:
-- their executors require an actual customer conversation and source message.
update public.ai_agent_templates
   set suggested_tool_keys =
         (suggested_tool_keys
            - 'coverage.propose_offer'
            - 'coverage.propose_request'
            - 'coverage.get_rates'
            - 'coverage.find_offers'
            - 'coverage.admin_list_offers'
            - 'coverage.admin_list_requests'
            - 'change_requests.list_pending')
         || '["coverage.get_rates","coverage.find_offers","coverage.admin_list_offers","coverage.admin_list_requests","change_requests.list_pending"]'::jsonb
 where system_template_key = 'admin_services';

comment on table public.ai_agent_templates is
  'Agent-builder templates. Coverage template suggestions include direction-aware quote/read/proposal tools; grants on an already-published revision remain immutable and must be updated through a new draft/revision.';
