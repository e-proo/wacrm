# SOF-17 — SP-2 + SP-3: Promotion wizard, provider routing and technical evidence

**Date:** 2026-11-17  
**Branch:** `refactor/service-platform-v2`  
**Scope:** SP-2 operator-facing campaign review/approval; SP-3 versioned Meta/OpenWA initial-message selection and shared Task transport.  
**Status:** implementation added / technical CI verification pending final exact HEAD; **no live TEST sends and no production changes**.

## Product / operator flow

The new dedicated Arabic RTL tab **Agents → ترويج الخدمات** is integrated into `src/app/(dashboard)/agents/page.tsx` and uses `ServicePromotionComposer`. It has three visually explicit stages:

1. **Campaign details:** select active service, published V2 promotion agent and a specific ready WhatsApp connection. Connection's `provider` is read from WACRM's account-scoped backend, never chosen from a model response. No implicit Meta/OpenWA fallback.
2. **Read-only audience and message:** server resolves exact deterministic tag-based contacts, required/excluded tag names, count and published limit, suppression and phone blockers, Meta marketing template or OpenWA text, account runtime/worker state and TEST OpenWA Pilot recipient grants. The operator sees the selected connection, template and each contact status. No DB task creation or provider send.
3. **Approval:** consent attestation and separate service/audience/message/connection acknowledgement, exact SHA-256 review fingerprint (not a digital signature), a 10-minute stale-preview limit, and server-side revalidation at creation. If anything changes, ask for re-preview. Launch remains disabled by default.

**UI components / APIs:**  
`src/components/agents/service-promotion-composer.tsx`;  
`GET /api/agent-tasks/promotion` (account-scoped picker: services, agents, connections, tags, recent tasks);  
`GET /api/agent-tasks/promotion/preview?serviceId=&agentId=&connectionId=` (read-only exact review);  
`POST /api/agent-tasks/promotion` (strict TEST-only reviewed Task creation; no immediate send).

**Permission gate:** `agents.manage_tasks` + `agents.manage_outreach` on both preview and launch. The account/user context always comes from the authenticated server session; the client cannot supply contact list or credentials.

## SP-3 versioned transport and business-owned message

- `services.promotion@1` remains registered with the historical model-first behavior. Existing tasks are not silently converted into new outbound behavior.
- New `services.promotion@2` references `services.promotion_message@2` with `generation:'deterministic'`. Worker bypasses model-authored first-touch prose and still executes standard Task authorization, tenant/scoped reservation and WhatsApp transport routing.
- **Meta Cloud:** the outbound candidate is the Arabic `service_promotion_v1` template with one frozen public-service-name parameter. Preview requires account-local `APPROVED` `MARKETING` template with `{{1}}`; actual connection/provider dispatch is still authoritative. Local template approval does **not** prove Meta Graph approval on the exact account.
- **OpenWA:** the outbound candidate is a fixed three-line Arabic service introduction with an explicit opt-out. No claim of Meta template approval is made. TEST requires an enabled OpenWA Pilot, per-recipient verified identity/consent grant, a ready session, and full WACRM transport guardrails.
- WACRM continues to own the **existing** reservation, unified outbound WhatsApp router, anti-abuse checks, status reconciliation and ambiguous-timeout no-blind-retry semantics. No new queue/CRM flow or direct OpenWA gateway sender was added.
- A V2 Task binds `target_policy.whatsappConnectionId`, freezes cohort IDs and public service facts, stores operator-review fingerprint and consent attestation as business audit, and remains subject to runtime/worker switches and SQL admission/revalidation.

## Security and concurrency

- The launch API is **off by default**, including on TEST; it requires `WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE=1` in the TEST deployment, AND live operator checks before any Task is created. This variable has **not** been enabled. Scheduled and legacy direct promotion launches fail closed to prevent unreviewed sends during this phase.
- The legacy `POST /api/services/[id]/promotion` no longer bypasses preview; it responds 409 with instructions to use the wizard, while its GET lists both versions.
- New **additive** migration `supabase/migrations/181_service_promotion_active_service_uniqueness.sql` enforces at most one active promotion Task for a given account and service (cross-version), protecting even concurrent administrator launches.
- TEST Supabase `pqirsnfupofhulmewakq`: pre-apply read-only query found no duplicate active promotion tasks; the migration was applied to **TEST only** via Supabase; read-only verification confirmed the partial unique index. No Production SQL was executed.
- GitHub [Migrations CI 44013319185](https://github.com/e-proo/wacrm/actions/runs/44013319185) on migration-bearing commit `a4eea2af372291b5a0d8bb2610145df443358c19` **completed/success**.
- No new client exposure of provider credentials, service-role secrets or OpenWA engine selection.

## Technical regression matrix (non-live)

| ID | Case | Test / code | Result |
|---|---|---|---|
| P2-01 | Admin/tenant auth, GET only account services/agents/connections/tags | `promotion/route.test.ts` | Added; CI gate |
| P2-02 | Preview freezes exact cohort and displays provider/template/recipients | `promotion-campaign-review.test.ts`, `preview/route.test.ts` | Added; CI gate |
| P2-03 | Preview expires after 10 minutes; modified cohort rejects approval | `promotion-campaign-review.test.ts` | Added; CI gate |
| P2-04 | Invalid input/foreign connection/blocked contact/missing template/paused connection | `promotion-campaign-review.test.ts`, `promotion/route.test.ts` | Added; CI gate |
| P2-05 | Unreviewed POST, unauthenticated or unauthorized POST, production POST | `promotion/route.test.ts` | Added; CI gate |
| P3-01 | V1 backwards-compatible policy; V2 registered distinctly | `agent-task-v2.test.ts` | Added; CI gate |
| P3-02 | Meta approved template vs OpenWA deterministic text, opt-out, no model prose | `agent-task-v2.test.ts` | Added; CI gate |
| P3-03 | Provider unknown, malicious service name, wrong role/version | `agent-task-v2.test.ts` | Added; CI gate |
| P3-04 | OpenWA TEST session & per-recipient Pilot grant | `promotion-campaign-review.test.ts`, existing task guardrails | Added; CI gate |
| P3-05 | SQL concurrency uniqueness; TEST-only replay | migration 181 + verification query | TEST index verified; CI migration success |
| P3-06 | Full TypeScript/lint/test/build/Meta regression on final exact HEAD | GitHub Actions CI | Await exact-HEAD outcome |

## Explicitly remaining before ANY live pilot

- SP-4: inbound multi-turn sales conversation → durable `customer_intents` / approved Request / staff handoff with real Target IDs and deduplication.
- SP-5: truthful completion/business outcome stats; a sent message or opt-out is not a sale.
- SP-6: full technical replay/negative security/regression and provider-specific Meta template readiness proof, no-send dry-run evidence, exact-HEAD successful CI, operational shutdown/rollback review.
- SP-7 / SOF-25: bounded real 1–3 consenting TEST contacts, *operator-authorized only after all above*. Neither a code commit nor CI allows a live send.

**Closure:** SP-2 and SP-3 are implemented at source level but cannot be declared `TEST verified` before final CI; SOF-17 remains `In Progress`; SOF-25 live acceptance remains `NOT RUN`. `PROJECT_NOTES.md` NOTE-001 continues to gate Production readiness.
