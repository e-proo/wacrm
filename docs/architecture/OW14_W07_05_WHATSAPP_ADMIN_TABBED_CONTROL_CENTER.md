# OW14-W07-05 — Tabbed WhatsApp administration and consent control center

**Date:** 2026-11-20. **Issue:** SOF-54. **Branch:** refactor/service-platform-v2.
**Scope:** UI architecture, authenticated control actions and safe Product/Legal disclosure staging. **No Supabase migration, hosted TEST/Production deployment, OpenWA gateway modification, or live send.**

## Design system and information architecture

The existing Settings → WhatsApp section was a long stacked screen showing Meta credentials, OpenWA session creation and cards, TEST Pilot, outbound review, reconciliation and a proposed risk disclosure. W07-05 reuses the existing Next.js, Tailwind, Base UI Tabs, Badge/Card/Dialog/Alert components; it does NOT invent new CRM or provider systems.

The landing surface is a **responsive, scrollable keyboard-accessible six-tab administration workspace**:

| Top tab | Focus | Roles | Notes |
| --- | --- | --- | --- |
| Overview | Quick entry cards, Meta connection status, provider risk preview and guidance | Any authorized settings reader | Read-only. CTA buttons switch the actual active tab, not a hidden anchor |
| Meta Cloud | Official/default provider credentials, save and connection check | Settings readers; writes require admin+ | Existing Meta functionality preserved, sensitive values masked/password inputs |
| OpenWA sessions | Session creation, QR, reconnect, webhook, rotation, pause/stop, remove, settings | Admin+ | Existing session lifecycle APIs and confirmation dialogs reused; no inline reconciliation |
| Pilot & limits | Selected session TEST Pilot controls, allowlist, guardrail/caps | Admin+, only authorized TEST Pilot capabilities | Does not imply owner operational consent |
| Consent & audit | Policy/approval, per-session requested activation, current reason/eligibility, audit history | Admin+ read; Owner accepts/revokes; Admin+ manages connection activation | Nested Policy / Connections / Audit tabs, not a multi-page form |
| Delivery review | A single account-level outbound review hub and selected-session deferred ACK/LID reconciliation | Admin+ | One connection at a time for detailed diagnostics, no blind resend |

The settings navigation uses the existing WhatsApp settings tab; it does not alter global Settings routes or sidebar. Existing OpenWA Connections becomes a **view-based presentation component** so it can display sessions, Pilot or delivery without duplicating the session lifecycle or worker logic. Selecting a session's "Pilot" or "Needs review" action navigates to the correct workspace tab with the selected connection.

## Consent and activation UX

Source: src/components/settings/openwa-operational-control-center.tsx, bilingual copy: whatsapp-admin-copy.ts.

- The server's GET operational-policy response is treated as authoritative: current approved version/digest, owner consent revision, requested activation of every same-account OpenWA session, safe reason codes and the most recent 20 consent + 20 activation audit entries.
- Four summary metrics, a prominent explicit **non-authorization warning**, and nested tabs for policy decisions, connection-specific actions and audit entries.
- Approved/absent/outdated consent and session reasons are visible in Arabic and English; **unknown or unavailable DB evidence never displays as approved**. HTTP 503 (e.g. migration 204 not applied to hosted TEST) is shown with clear explanation and a retry button, not an empty-connection dashboard.
- The admin sees statuses but not QR, gateway keys, webhook signatures, raw session identifiers, delivery secrets, recipient numbers or full provider payloads. Actor IDs in audit history are shortened in the UI; server only returns account-scoped safe metadata.
- Owner-only accept/revoke and owner/admin enable/suspend/disable buttons are bound to W07-03 APIs. Actions use a confirmation dialog with explicit acknowledgment. The action button is gated by server-provided mutation_stage + role + current policy/session/consent state; the server and SQL independently revalidate all permissions.
- Every POST has an RFC-4122 UUID request_id, expected_revision, trusted same-origin credentials and is sent only after direct action confirmation. If the network result is ambiguous, the dialog retains the SAME request_id/revision for an explicit retry; never blindly issues a second logical decision. Revision conflicts trigger an authoritative refresh.
- No action calls a WhatsApp sending API, starts a worker, alters TEST Pilot, bypasses W07-04, or changes Meta routing. A stored requested_activation=enabled is NEVER presented as recipient-specific send_authorized=true.
- Revocation/suspend/disable remain available to eligible operators even with stage flags closed, provided migration 204 exists and actor access checks pass. Accept and enable stay closed until independent server flags and policy evidence permit them.

### Hard Product/Legal publication fence

Migration 204 intentionally seeds **no approved version** and the current W07-01 policy is labeled **draft**. To avoid the operator accepting a hash without seeing the actual approved terms, W07-05 adds a server-side approved-policy-catalog.ts registry with NO entries by default.

1. Only Product/Legal-reviewed bilingual full wording with a recorded approval reference may be published in a later authorized commit; the draft text must never be reused implicitly.
2. The registry computes SHA-256 over a canonical bilingual content string. The published DB policy version/digest must match it EXACTLY.
3. GET exposes AR/EN approved terms ONLY if registry + DB digests match; otherwise terms=null and owner acceptance is disabled visibly.
4. POST accept also rejects when the exact approved wording is unavailable, even if someone toggled WACRM_W07_CONTROL_WRITES_ENABLED=true. This is a **second independent legal-content gate**, not a bypass or a replacement for SQL owner authorization.
5. To activate later, Product/Legal must approve a final version and matching additive SQL publication, and an operator must explicitly review/acknowledge the terms; W07-04 runtime release and independent recipient permission still apply. No owner acceptance is auto-seeded.

## Responsibilities and invariant tests

- src/components/settings/whatsapp-config.tsx — tabbed top-level WhatsApp UI, role-gated navigation, Meta view and overview CTA cards.
- src/components/settings/openwa-connections.tsx — view-based sessions/Pilot/delivery, per-session navigation, QR/edit/remove dialogs retained; reconciliation moved to the selected-session delivery panel.
- src/components/settings/whatsapp-provider-choice-preview.tsx — preview links replaced by actual navigable tab actions.
- src/components/settings/openwa-operational-control-center.tsx — safe reads, confirmation controls, request-id retry, reason/status audit views, responsive RTL.
- src/components/settings/whatsapp-admin-copy.ts — centralized bilingual UX strings; separate from legal policy wording.
- src/lib/whatsapp/transport/openwa/approved-policy-catalog.ts — no approved terms seeded, digest-checked future publication.
- src/app/api/whatsapp/connections/openwa/operational-policy/route.ts — redacted approved terms where matching, hard POST accept check and accurate owner_accept_available flag.

**CI requirements**: Lint, TypeScript, Vitest, Meta/OpenWA regression and production Build on exact HEAD; tests for 6-tab separation, role gates, copy parity, no draft approval, 503 unavailable/fail closed, content digest and API identity/consent/stage contract. W07-02 migration SQL smoke already covered separately in GitHub Migrations clean replay and is unchanged by W07-05.

## Security/rollback/acceptance

- The UI is not a new authorization boundary. Account isolation occurs in requireRole + same-account service SQL RPC and RLS; no user-provided actor/account IDs are accepted.
- Keep WACRM_W07_CONTROL_WRITES_ENABLED OFF by default and WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED OFF until W09 GO; TEST Pilot remains separate. No policy text is approved in this commit.
- If TEST migration 204 is unavailable, a red error state blocks all action views; it MUST NOT display fabricated empty state as a success.
- A future per-connection action revoking an in-flight provider request cannot retroactively unsend it. Existing ACK/receipt/reconciliation remains available without sending again.
- All new text/UX files can be reverted independently if necessary; this stage makes NO schema, Meta send, worker or gateway modification.
- Manual visual/keyboard/mobile RTL/English browser QA remains a separate acceptance gate; build and unit tests alone are not live TEST verified.

**DoD evidence level at implementation:** code + exact-HEAD CI if and only if the workflow finishes success. Never claim Product/Legal approval, hosted TEST migration, live acceptance or Production ready from UI code alone. W06 backup/DR and NOTE-001 security debt remain separate OW14 blockers.

## Verification record — 2026-11-20

- **Initial candidate:** 7a7c30e0d0fa3f52882520b3467bd871f6fd45de; first GitHub CI 44750555997 failed exactly one historical source-layout assertion in openwa-outbound-review-sessions.source.test.ts because it expected the outbound review hub before the connection cards within a single long screen.
- **Correction:** de565eeed141080e14fda6e5b660f3c5b5edfa53 updates that source test to assert the new, stronger contract: one review hub in the Delivery tab, session cards only in Sessions, and one selected-session reconciliation panel. No runtime authorization was weakened to pass the test.
- **Exact-HEAD CI:** https://github.com/e-proo/wacrm/actions/runs/44751162269 — completed/success on de565eeed141080e14fda6e5b660f3c5b5edfa53. Passed Lint, TypeScript, Hostinger TEST scheduler checks, W06 inventory checks, OW-4/Meta session regression, full Vitest suite and Next.js production Build.
- **Result:** W07-05 implementation complete + CI verified on ephemeral GitHub runner. Manual Windows-browser RTL/mobile/keyboard QA, hosted Supabase TEST migration 204, Product/Legal policy publication and bounded live acceptance remain **PENDING**. Do not claim those levels as passed or alter VPS/Production.
