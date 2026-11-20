# OW14-W07-00 — Provider, consent and activation contract (ADR)

**Status:** Architecture/permission contract prepared for engineering; Product/Legal/Security review pending.
**Date:** 2026-11-20.
**Audited source:** e-proo/wacrm, refactor/service-platform-v2, initial HEAD 8cda85d52140b91b3b1838e76f6fc036de1a8359.
**Scope:** W07-00 and W07-01 groundwork only. This is NOT a live send gate or Production authorization.

## Current implementation inventory (reuse, never fork)

| Concern | Existing source of truth | W07 integration point |
| --- | --- | --- |
| Provider/default routing | src/lib/whatsapp/transport/router.ts | Empty connection selection remains Meta; do not reroute silently |
| OpenWA ready session/credentials | src/lib/whatsapp/transport/openwa/adapter.ts and credentials.ts | Existing account-scoped credential access |
| Policy, pilot and circuit guards | src/lib/whatsapp/transport/guardrails.ts | Future gate in shared OpenWA boundary before dispatch |
| Session admin | src/lib/whatsapp/transport/openwa/session-auth.ts | Admin+ manages sessions; never expose keys to agents |
| Account roles | src/lib/auth/roles.ts | Owner alone will accept/revoke risk terms; admin+ may manage activation |
| Settings UX | src/components/settings/whatsapp-config.tsx, openwa-connections.tsx | Separate provider information from TEST Pilot and session control |
| Conversation and broadcast send choices | src/app/api/whatsapp/conversations/send-connections/route.ts, broadcast/connections/route.ts | Informative effective-state reasons; enforcement must remain server side |
| Provider-neutral identity and TEST Pilot | Supabase migrations 143–203; TEST Pilot 155,156,194 | Do not repurpose pilot_enabled as production opt-in |
| Existing ACK and unmatched states | W05 reconciliation pathways | Continue inbound/ACK and operator review while outbound is suspended |

## Decisions to freeze before next packages

1. **Meta is official/default.** OpenWA is opt-in, self-hosted, unofficial linked-device transport, never an automatic provider fallback.
2. **Distinct consent scopes:** account owner accepts one approved policy version; a privileged operator activates a specific connection after consent; end-recipient permission/marketing opt-in stays independently required. Neither server connection readiness nor TEST Pilot is consent.
3. **Two-phase account-state policy:** On Production there is zero implicit activation or seeded accepted record, even for previously linked devices. A material policy revision invalidates old acceptance, with historical events retained.
4. **Connection activation is state-only**, not a worker trigger, queued dispatch, or automatic resend. Expiry/revocation/suspension affects future sends, while already handed-off provider requests require reconciliation.
5. **Owner-only policy acceptance and revocation; Admin/Owner activation**, Agents/Viewers no mutation. QR, profiles and credentials remain Admin+ only, with account-scoped access. This is a proposed server authorization contract until W07-03.
6. **Single send-time admission gate** within the existing WACRM OpenWA transport, with recheck immediately before provider dispatch after pacing. All manual/broadcast/automation/API/agent/worker workloads flow through it; Meta path unchanged. Never add a parallel engine.
7. **Fail closed for Production** on missing/old/revoked consent, missing activation, wrong account/session, unknown policy, unavailable DB, environment release feature OFF, manual pause or circuit open. W07-04 must enforce before actual send and issue stable safe denial reasons.
8. **No blind resend and no fabricated delivery state.** Inbound webhook, deduplicated ACK, read and reconciliation remain available even when outbound is disabled.
9. **PII minimization:** version, digest, actor ID, time, scoped account/connection and safe reason code only for consent events; no phone/JID, message bodies, QR, session profiles, API/HMAC keys or secrets.
10. **Append-only migrations and audits.** Do not modify applied schema. Every admin/service-role path rechecks account_id + connection_id; RLS/SQL negative tests prevent cross-account reads/mutations and race conditions.

## Planned database contract (W07-02 — NOT yet created)

- Versioned account-level policy acceptance/revocation events. Immutable author, version/digest and timestamp; explicit current acceptance is derived atomically, not a browser checkbox.
- Provider-neutral/account-scoped OpenWA operational activation at connection level with status disabled/enabled/suspended and revision for compare-and-set.
- Append-only activation audit with actor, old/new state and safe reason; no raw recipient or credential.
- Service-only RPC or audited server transaction validates actor/account/connection/version in the same operation. Never use service_role as a reason to skip tenant-scoped filtering.
- Production environment feature gate defaults OFF pending OW14-W09 approvals, while TEST Pilot controls remain operationally separate. No grandfathering existing connections into Production.

## Proposed behavior matrix (W07-03/04, not current live behavior)

| Condition | OpenWA outbound | Other behavior |
| --- | --- | --- |
| Account never accepted policy | Deny | Meta unaffected |
| Owner accepted older revision | Deny until reaccepted | History retained |
| Admin enables eligible connection with current owner acceptance and release gate | May proceed through existing guardrails | Activation alone never dispatches |
| Account policy revoked / connection suspended | Deny any future dispatch | In-flight/ACK reconciled separately |
| Client/DB unavailable or wrong tenant ID | Deny | No credentials exposed |
| TEST Pilot disabled but Production gate OFF | Deny on Production | TEST existing pilot remains separate |
| Already handed off a provider request before revoke | Do not invent outcome | Native reconciliation; no automatic retry |

## Permissions (design, not yet API enforcement)

| Operation | Owner | Admin | Agent | Viewer |
| --- | --- | --- | --- | --- |
| Read policy disclosure | Yes | Yes | Authorized read only | Authorized read only |
| Accept/revoke risk policy | Yes | No | No | No |
| Enable/suspend individual connection | Yes | Yes | No | No |
| Manage linked device, QR, gateway credentials | Existing admin+ | Existing admin+ | No | No |
| Set Production deployment release gate | No browser role | No browser role | No | No |

The pure draft role helper at src/lib/whatsapp/transport/openwa/operational-policy-draft.ts is only a **proposal**. UI visibility must never replace server-side authorization.

## Open decisions and required reviewers

- Product/Legal: final bilingual wording, platform-policy references, consent retention and jurisdiction clauses; signed new published policy version/digest.
- Security/DB: exact schema, role/RLS grants, owner verification, audit immutability, transaction/replay and secret/QR redaction.
- Engineering: single admission path and race semantics, phased TEST rollout preserving existing sessions, deprecation of old UI Pilot ambiguity.
- Support/Ops: session reconnect/QR assistance, restrictions, uncertain sends and incident escalation; no unmeasured SLA/RTO promise pending W06.
- Release: which actor can turn on Production environment gate after explicit W09 GO; no UI-controlled global bypass.

## Acceptance gates and limits

**W07-00 implementation output:** this ADR, source inventory, type/role proposal, unit tests and review obligations.
**W07-01 output:** localized, versioned DRAFT copy and informational responsive preview UX with accessible review modal/FAQ and NO write endpoint.
**Not implemented here:** Supabase migration (W07-02); tenant/role-guarded APIs (W07-03); effective pre-send gate (W07-04); live activation UI (W07-05); operational escalation system (W07-06); live TEST evidence (W07-08).

Do not run VPS commands, deploy to Production, change Supabase TEST remotely or send WhatsApp messages during W07-00/01 development. OW14-W06 deferred and W05/OW12/OW13/NOTE-001 remain independent production gates.
