# OW14-W07-07 — Technical security, concurrency and regression audit evidence

**Date:** 2026-11-20  
**Branch/source of truth:** e-proo/wacrm @ refactor/service-platform-v2  
**Issue:** SOF-54  
**Scope:** code/SQL/CI audit; NO live WhatsApp sends or Production deployment.

## 0. State and decision discipline

This document distinguishes: **implementation complete**, **CI + clean-local-DB verified**, **hosted TEST verified**, **manual operational/security acceptance**, **live acceptance complete**, and **Production ready**. Only actual positive evidence counts. W07-08 requires a separate authorization; W06 DR remains deferred.

Starting HEAD for W07-07: c2e8118e839eec991682af0d87bc65e6c465d6b5 (W07-06). Audited implementation baseline: commit 11c3ed9b16fa71fbd5dd2d9d2a0f1a4c72f0bf3a. Later post-dispatch audit correction commit 85a33aa43810e481827480857885d06d4c601115. Always recheck fresh current HEAD when executing next-stage work.

**IMPORTANT: W07-07 is not a live acceptance or W09 production rollout.** This technical package does not publish a legal policy, accept on behalf of owners, enable any session, apply a hosted migration, or start workers.

## 1. Audited inputs and source evidence

- Full implementation plan: plans/WhatsApp Multi-Provider OpenWA Integration/14_OW14_W07_PROVIDER_CHOICE_CONSENT_AND_SUPPORT_IMPLEMENTATION_PLAN.md, W07-00..07, Definition of Done and 18-item security matrix.
- W07-02 additive migration: supabase/migrations/204_openwa_operational_consent_activation.sql (**NOT edited**); RLS, service-only invoker RPC, owner/admin roles, per-account advisory serialization, optimistic revisions, append-only audit, same-event activation.
- SQL smoke: supabase/ci/openwa-operational-consent-activation-smoke.sql, with synthetic account A/B, owner/admin/agent/viewer, version mismatch, replay conflict, revoke/reaccept, cross-account FK and RLS/privilege negatives; SQL transaction ROLLBACK, no policy actually published.
- New W07-07 parallel SQL smoke: supabase/ci/openwa-operational-concurrency-smoke.sh (**localhost:54322 only**). Two independent SQL connections race on consent revision 0, then activation revision 0, then revoke versus enable. Exactly one CAS winner, one revision conflict, audit count checks; effective activation must be false after revoke.
- W07-03 POST/GET: src/app/api/whatsapp/connections/openwa/operational-policy/route.ts and [connectionId]/operational-activation/route.ts; strict requireRole, account/actor from authenticated server context, same-origin JSON, bounded input, request UUID and expected_revision; stage flags OFF by default. W07-05 approved bilingual policy registry remains EMPTY pending Product/Legal; no draft opt-in.
- W07-04 guarded and raw transport: src/lib/whatsapp/transport/guardrails.ts and openwa/adapter.ts with last-chance same-tenant ready-session proof; OpenWA only, Meta official/default, unchanged inbound/ACK/reconciliation and Pilot/STOP/caps.
- W07-05/06 Settings: seven top-level WhatsApp tabs, explicit admin governance, read-only support diagnostics and sanitized operator handoff.
- Existing regression: W07 unit/route integration, W05 ACK reconciliation, OW-4 QR/Meta, scheduled workers, inbound LID/ACK/media, service/agent/broadcast admission and existing SQL smokes.

## 2. Findings discovered and fixes implemented

### F-01 — Same count, different connection identities could evade support discrepancy check

**Prior condition:** Two account-scoped GETs were treated as consistent when their **lengths** matched, even if the actual connection identities differed. This could falsely present a successful combined diagnostic after a race or a tenant-isolation bug. It was NOT evidence of an actual cross-tenant leak.

**Hardening:** support-diagnostics.ts validates each returned connection shape, unique UUID identity, non-authorizing state and guardrail/review evidence; compares **exact identity sets inside memory**. On mismatch, aggregate counts and approval flags are withheld (null), consistency=false, and the human P0 isolation review is suggested. The sanitized clipboard report never contains these IDs. Tests inject same-count mismatched/duplicated IDs, forged send_authorized and missing guardrail/review fields. No exposed secrets or extra API/DB permissions.

### F-02 — Unknown consent POST outcome could lose its request UUID on dialog close

**Prior condition:** W07-05 admin dialog preserved its request UUID only while open; closing an ambiguous-result dialog discarded the key, and another click might create a separate logical decision.

**Hardening:** keep pendingRetry request identity across dialog closing/reopening and only retry exactly the same account/action/connection/revision/policy fingerprint. Block a different action while unresolved until a verifiable refresh/settlement; revision conflicts use authoritative refresh. Server CAS and unique scoped request ledger remain the source of truth. UI changes alone do not approve anything.

### F-03 — Support snapshot could remain visible for one frame across role/account change

**Hardening:** tag each read-only diagnostic result with the account/permission scope; render/copy only if it matches the current account and role **synchronously**, not merely after React effect cleanup. Abort old requests, clear state and never retain data in localStorage or send support data elsewhere. No customer identifiers appear in the support export.

### F-04 — Post-provider audit network exception could overwrite actual provider outcome

**Prior condition:** GuardedOpenWATransport's post-dispatch record RPC failure by thrown exception could get caught as transport failure after the provider returned a successful acceptance. An ambiguous original provider failure could likewise be replaced by an audit exception. The initial reservation remains mandatory and fail-closed.

**Hardening:** post-dispatch guardrail outcome logging is best-effort with sanitized failure notice; it cannot transform provider acceptance into failed transport or hide an original ambiguous error. Provider result and existing WACRM delivery/reconciliation evidence remain authoritative. Two negative tests inject a thrown post-dispatch audit RPC after success and after ambiguous failure. Do not confuse a successful *provider acceptance* with recipient delivery.

### Residual design boundaries (not implementation blockers but not Production proof)

- A revocation cannot retroactively cancel a native provider request already started. Keep exact idempotency and reconciliation; no blind resend.
- A reserved guardrail capacity unit may remain conservatively consumed if STOP/revoke occurs during pacing. It is not proof of delivery; don't fabricate success or rewrite historic counters.
- Pinned Supabase TEST still defaults to the **legacy TEST Pilot-only** W07 mode; full policy gate on TEST requires explicit WACRM_W07_TEST_GATE_MODE=enforce during separately authorized acceptance. All non-TEST environments require current consent/activation and an OFF-by-default release flag.
- A signed policy version is intentionally unpopulated; there is no Product/Legal approval. Consent/enable writes remain OFF by default. A CI synthetic approved policy is rolled back.
- Human browser screenshots, real signed-off tabletop cases and live recipient tests do not emerge from a green CI run.

## 3. Verification matrix mapped to W07-R01..R18

| ID | Technical evidence / gate | Current technical classification |
| --- | --- | --- |
| R01 Role privilege | Owner-only accept/revoke, admin enable/suspend/disable, viewer/agent negatives in route Vitest + SQL smoke | Code + local CI verified |
| R02 Tenant isolation / IDOR | account-scoped GET/RPC, invoker owner membership, composite connection/account FK, cross-account SQL negatives | Code + local SQL verified; hosted W07 schema unavailable |
| R03 Signed legal wording | empty Product/Legal catalog and digest-checked API accept; stale/draft denies | Default-deny verified; Product/Legal publication PENDING |
| R04 Stale activation | acceptance event UUID and per-connection event-bound activation, revoke/reaccept SQL negatives | Code + local SQL verified |
| R05 TOCTOU | Guarded admission before reservation and raw adapter last proof; revoke/suspend/rotate during pacing tests | Code + CI verified; live in-flight boundary NOT proven |
| R06 STOP/circuit/caps | existing guardrail safety and dedicated TEST Pilot admission regression | Code + CI verified |
| R07 Meta parity | router defaults Meta; OpenWA optional; Meta/OW-4 dedicated CI regression | Code + CI verified |
| R08 Ambiguous outcomes | providerDispatchAttempted=false for explicit local denial, W05 ACK settlement, guardrail audit exception isolation | Code + CI verified; live settlement deferred |
| R09 Concurrency/replay | server request UUID + expected_revision; two independent local psql callers race consent/activation/revoke | Local SQL concurrency CI verified |
| R10 Schema & grants | migration 204 clean replay and service_role invoker, no anon/auth grants, rollback smoke | LOCAL replay verified; **HOSTED TEST NOT APPLIED** |
| R11 Privacy | injected secret/phone/ID/URL/audit actor suppressed from sanitized snapshot; no support POST | Code + CI verified |
| R12 Invalid UI/account state | 401/403/503/invalid read negative, unknown POST retry fence and account-switch result suppression | Automated verified; manual browser QA PENDING |
| R13 TEST/Production fences | pinned TEST legacy mode separated from enforce-test; unknown/non-TEST flag OFF | Code + CI verified; TEST enforce acceptance pending |
| R14 Session auth/QR | OW-4 session/QR + Meta regression, admin-only credential/QR routes | CI verified; W07-specific browser QA pending |
| R15 Support SOP | bilingual 16 incidents, 8 guides, 13 FAQ, owner/severity/forbidden, no side effects | Guide/code verified; human tabletop/signoff PENDING |
| R16 Scoped support reads | existing owner/admin GET + exact in-memory connection-ID parity before aggregate report | Code + CI verified; human tenant case pending |
| R17 Worker cutover | code-level TEST pin + server schedule opt-in, scheduler regression | Code/CI verified; actual Windows/VPS runtime ownership NOT VERIFIED |
| R18 Locale, build, accessibility | Arabic/English copy/test completeness, 7 tabs, TypeScript/Next Build and source contracts | Code/CI verified; real RTL/mobile/keyboard QA PENDING |

A row marked "Code + CI verified" is **NOT** hosted TEST verified, live accepted or Production ready.

## 4. Independent evidence: hosted Supabase TEST — READ ONLY

On 2026-11-20, we inspected the actual authorized Supabase project **wacrm test** via read-only migration listing, schema-presence SQL and Security Advisor. No SQL mutation was run:

- Migration history ends at W05 ACK audit (20261120002434) and does **not** contain 204_openwa_operational_consent_activation.
- to_regclass() for openwa policy registry, consent state and activation state were all **false**. to_regprocedure() for consent and activation RPCs were likewise **false**. Therefore W07-02 schema is **NOT APPLIED ON HOSTED TEST**; W07 consent/activation UI must fail closed with 503 if invoked.
- Supabase Security Advisor returned one existing warning: auth_leaked_password_protection disabled. Project note NOTE-001 is **open** even though prior database SQL advisor classes were addressed. Remediation info: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection. The owner must address this independently; do not silently modify Auth settings during audit.
- We did NOT inspect/change Production, send any WhatsApp message, apply migration 204 to hosted TEST or alter the server scheduler/Windows process.

## 5. CI and verification references

- Existing W07-06 exact-HEAD baseline: https://github.com/e-proo/wacrm/actions/runs/44758512555 completed/success on c2e8118e839eec991682af0d87bc65e6c465d6b5.
- W07-07 concurrency, UI/consent/scope test package: 11c3ed9b16fa71fbd5dd2d9d2a0f1a4c72f0bf3a.
- **Migrations** https://github.com/e-proo/wacrm/actions/runs/44771991558 completed/success on 11c3ed9b16fa71fbd5dd2d9d2a0f1a4c72f0bf3a, including clean reset, W07 policy/account RLS rollback smoke and new W07 parallel CAS smoke (no hosted DB).
- **Application CI** https://github.com/e-proo/wacrm/actions/runs/44771991523 completed/success on 11c3ed9b16fa71fbd5dd2d9d2a0f1a4c72f0bf3a (Lint, TypeScript, full Vitest, OW-4/Meta regression, Build).
- Provider outcome preservation fix: 85a33aa43810e481827480857885d06d4c601115. **Application CI** https://github.com/e-proo/wacrm/actions/runs/44772761672 — **completed/success on exact code SHA** (Lint, TypeScript, full Vitest including the two guardrail audit-failure regression tests, OW-4/Meta regression and Build). Documentation-only HEAD requires separate verification.

## 6. Operator/QA sign-off package — to be executed before W07-08

The ten synthetic tabletop cases (NO real messages) are detailed in docs/operations/OW14_W07_07_PRE_ACCEPTANCE_REGRESSION_AND_TABLETOP_MATRIX.md. For each, require: incident ID, date, owner (internal), approved user role, screen/HTTP proof with secrets redacted, expected and observed outcome, recovery action, rollback and reviewer initials.

**Human review needed:**
- P0 duplicate worker: verify the *actual* Windows local process and VPS scheduler, no two send owners on a shared TEST queue; cannot be proven through GitHub.
- P0 credentials and cross-tenant anomaly: validate human escalation and privacy/no QR/JID, then account isolation review.
- P1 ambiguous provider timeout and signed webhook/ACK delayed: no blind resend, auditable unverified disposition, no HMAC relaxation.
- P2 QR relink, consent 503/outdated, unresolved @lid with native proof: confirm correct per-session options and admin/owner role separation.
- UI: test Arabic RTL/English LTR with Chrome/Edge on Windows and small mobile viewport. Keyboard Tab/Arrow/Escape; focus trapped in confirmation; screen reader labels, scrollable top-level and nested tabs; owner/admin/agent/viewer, manual STOP, safe missing migration warnings and support clipboard output.
- Security/Product/Legal/Support approval of text and operational practices, not just code. Actual approved version/content digest must be published through a new authorized additive migration after 204 is applied.
- Only later: bounded and independently authorized hosted TEST W07-08 acceptance. W06 backup/restore and NOTE-001 Production blockers remain.

## 7. Decision gate

**Technical implementation + CI:** verified on explicitly cited SHAs only.  
**Hosted TEST W07-02 migration 204:** NOT applied (read-only evidence).  
**Manual browser/tabletop/Product/Legal/Security acceptance:** OPEN.  
**W07-08 live acceptance authorization:** **HOLD**.  
**OW14 Production GO / W09:** **NOT READY**.  
**W06:** deferred as requested. No Production environment changed.

Do not close SOF-54 or claim W07 fully completed/production ready until the pending independent gates are satisfied. Preserve all current Meta and OpenWA inbound/receipt/reconciliation behaviors.


## Final runtime-check update — 2026-11-20

- Exact runtime HEAD before evidence-only commit: 85a33aa43810e481827480857885d06d4c601115. CI run 44772761672 **completed/success**.
- Local migrations/concurrency SHA 11c3ed9b16fa71fbd5dd2d9d2a0f1a4c72f0bf3a, run 44771991558 **completed/success**. The later 85a33aa commit modified only guardrails.ts and guardrails.test.ts; migration 204, W07 SQL smoke and workflow inputs were unchanged.
- Guardrail tests confirm a successful provider response remains successful even when the secondary post-provider audit RPC throws; likewise an original ambiguous transport failure remains unchanged. Logs do not expose private identifiers.
- W07-07 **automated code and clean-local-DB verification passed**; manual browser/RTL/keyboard, hosted TEST schema/application, Product/Legal/Security/Support review, Windows/VPS runtime ownership and real WhatsApp W07-08 acceptance remain **OPEN**.
