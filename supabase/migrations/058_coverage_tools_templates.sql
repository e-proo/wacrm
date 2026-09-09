-- ============================================================
-- 058_coverage_tools_templates.sql — wire coverage tools into the
-- builder templates (Phase: coverage integration)
--
-- Append-only, guarded updates to suggested_tool_keys so the
-- builder's template clones include the coverage marketplace
-- tools added alongside migration 057's intents tooling.
--
-- Mapping per plan §4 template table:
--   coverage        + coverage.find_offers
--                     (availability + find_offers; proposals stay
--                      OFF by default for the customer-facing
--                      coverage agent)
--   admin_services  + coverage.find_offers + coverage.propose_offer
--                     (the admin agent is the one allowed to
--                      propose offers for customer liquidity)
--   customer_service stays unchanged — least privilege.
--
-- Idempotent: the NOT ?| guard skips templates already carrying
-- any of the appended keys.
-- ============================================================

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys
         || '["coverage.find_offers"]'::jsonb
 where system_template_key = 'coverage'
   and not (suggested_tool_keys ?| array['coverage.find_offers']);

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys
         || '["coverage.find_offers","coverage.propose_offer"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ?| array[
     'coverage.find_offers', 'coverage.propose_offer'
   ]);
