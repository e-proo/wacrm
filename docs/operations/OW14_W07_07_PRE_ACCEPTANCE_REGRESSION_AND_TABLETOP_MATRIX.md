# OW14-W07-07 — Pre-acceptance regression and security audit matrix

**Date:** 2026-11-20 · **Issue:** SOF-54 · **Branch:** refactor/service-platform-v2  
**Status:** PREPARED / NOT EXECUTED as an independent W07-07 closure. No live acceptance is authorized.

This is the **next technical phase after W07-06**. The presence of a green W07-06 CI run is NOT sufficient to close W07-07 or the W07 programme. Run this matrix against fresh HEAD, implementation, migrations, CI, TEST evidence, Definition of Done, PROJECT_NOTES and Linear. Report precise evidence level.

## A. Automated verification matrix

| ID | Risk | Required proof and negative case | Target owner |
| --- | --- | --- | --- |
| W07-R01 | Owner cannot act as admin / admin impersonates owner | requireRole owner-only accept/revoke, admin can only manage activation, forged actor/account rejected | Auth/API |
| W07-R02 | Cross-account IDOR | Every GET/POST, service SQL RPC and W07 gate account/connection/provider scoped; no unfiltered service-role leakage | Security/DB |
| W07-R03 | Stale legal terms | Published bilingual legal text digest matches independent DB policy; draft never accepted or seeded; revocation and version change block outbound | Legal/API |
| W07-R04 | Stale activation | Reaccept changes audit event; old enabled session cannot silently regain send permission | Transport/SQL |
| W07-R05 | TOCTOU | Owner revoke or connection suspend after reservation but before provider call fails closed; rotated session cannot dispatch | Transport |
| W07-R06 | Manual pause / circuit / cap | Existing guardrail checks still reject even if consent is current; no unchecked fast path for zero pacing wait | Transport |
| W07-R07 | Provider parity | Meta/default routing and template rules unchanged; OpenWA optional; inbound unified pipeline and ACK/read reconciliation available while outbound denied | Providers |
| W07-R08 | Safe uncertain outcomes | W07 refusal providerDispatchAttempted=false; provider timeouts remain ambiguous; worker no blind resend | Delivery |
| W07-R09 | Concurrency | Parallel owner consent/revoke/enable conflict uses expected_revision + stable request_id and deterministic CAS; repeated same request id is idempotent | API/SQL |
| W07-R10 | No SQL bypass | Migration 204 RLS/grants/SQL RPC scoped, immutable applied migrations, clean replay + isolated TEST smoke only when authorized | DB/Security |
| W07-R11 | Support confidentiality | Malicious raw API data (QR, keys, JID, phone, actor ID, URLs, HTML errors) never reaches support report; no automatic support network POST | Support/Security |
| W07-R12 | UI 503/role/error | Missing migration, invalid JSON, 401/403 and account switch are unavailable, never fake green/empty or enabled | Frontend |
| W07-R13 | TEST vs Production | Exact TEST pin only, Pilot remains distinct, invalid TEST mode fail-closed, unknown/non-TEST requires off-by-default release flag | Release |
| W07-R14 | Session/onboarding | QR/admin-only, same-account exact session/reconnect, duplicate-create timeout not an automatic retry, credential rotation separated | OpenWA |
| W07-R15 | Help operator SOP | P0/P1/P2 tabletop, owner roles, UI navigation, checklist without side effects, escalation and "never do" warnings | Support/Ops |
| W07-R16 | Tenant-scope on support reads | Both GET operational-policy and GET connections independently require server auth; mismatch is diagnostic error, not approval | API/Security |
| W07-R17 | Scheduler cutover | Windows-only dev worker and VPS scheduler ownership verified; no concurrent consumption of one TEST queue | Operations |
| W07-R18 | Build and locale | Arabic RTL, English LTR, small/mobile viewport, keyboard navigation and accessible focus, full exact-HEAD CI | QA |

## B. Human tabletop acceptance (required before W07-08)

Use **synthetic** scenarios and sanitized reports. No real WhatsApp sends:
1. P0 duplicated Windows/VPS worker: identify runtime owner and STOP; prove browser closure is insufficient; reconcile reserved outcomes.
2. P0 leaked OpenWA gateway key: confirm no secrets/QR in support snapshot, initiate scoped incident handling and preserve evidence.
3. P0 cross-account anomaly: block admin actions, preserve minimal evidence and review auth/RLS without security relaxation.
4. P1 ambiguous send after gateway timeout: inspect native status, no blind resend, close unverified only with audit and proof status not fabricated.
5. P1 signed webhook failure or read/ACK backlog: validate HMAC/replay/dedup, STOP if necessary, do not mark delivered without correlation.
6. P2 session disconnect/QR: same connection, admin-only QR, no duplicate create; confirm read-only status and reconciliation.
7. P2 unapproved/revoked/outdated terms: no accept without approved bilingual text; owner acceptance + new event bound to activation.
8. P2 missing migration 204/API 503: fail closed, not zero connections; do not enable RLS/Data API.
9. P2 unresolved LID: no phone inference; native proof required before unified CRM processing.
10. Mobile keyboard/Arabic and English with agent vs admin vs owner: no privileged actions shown or accessible to agent; no false send-authorized label.

For each: owner name/role (internal, not copied to public report), scenario ID, observed safe outcome, failing path, timestamp, rollback action if any, evidence URL/ref, reviewer sign-off, and unresolved risks.

## C. W07-07 release evidence packet

A **separate** result must include:
- Fresh HEAD SHA and diff for W07-00..W07-06, current migrations list and additive schema proof.
- GitHub Actions URL with exact HEAD **completed/success**: Lint, Typecheck, full Vitest, Meta/OpenWA regression, Build, SQL clean replay/smokes as applicable.
- TEST environment deployment record (none inferred from CI), database migration status, non-production config, owner of scheduled workers.
- Product/Legal/Security/support reviews and policy version/content digest (NOT the W07-01 draft).
- Redacted negative-test and security evidence, tabletop results, manual browser RTL/mobile QA.
- All open issues/risks and explicit W07-08 live TEST acceptance **GO/HOLD**, separately authorized by owner.
- W06 deferred and NOTE-001 security debt explicit; neither green CI nor W07 support UI equals Production ready.

**No changes to VPS, hosted Supabase, real WhatsApp recipients or Production are part of this matrix preparation.**


## 2026-11-20 W07-06 technical prerequisite reference

W07-06 code was CI-verified at 4e9623067802eeb39fed91a036b34604038bf84c, https://github.com/e-proo/wacrm/actions/runs/44757632706 (completed/success). This establishes only the prerequisite operator UI, sanitized diagnostic snapshot and bilingual guide tests. It does NOT execute W07-07 threat, concurrency, SQL/TEST, human tabletop, real browser a11y, Legal or live acceptance checks. The checklist above remains open until a separate exact-HEAD W07-07 evidence review and sign-off.
