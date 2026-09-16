# Messaging Platform Rollout Plan

## Objective

Move WACRM operational messaging from scattered hard-coded strings to the generic Messaging & Business Events Platform without changing business decisions, approval semantics, execution ownership, or transport safety.

## Current status — 2026-09-16

Work is active only on branch `test/ai-runtime-kb-tools-v2` and TEST/STAGING. Production must remain untouched until a separate explicit promotion decision.

Current implementation status:

- Phase 0 — foundation: ✅ implemented
- Phase 1 — trusted-admin pending approval: ✅ implemented
- Phase 2 — trusted-admin approval/rejection outcomes: ✅ implemented
- Phase 3 — coverage customer outcomes: ✅ implemented in runtime; final TEST end-to-end delivery recheck remains after the atomic outbox-claim fix
- Phase 4 — exchange-rate / currency-trade messaging: ⏸ deferred because the service/runtime itself is not ready
- Phase 5 — remittance messaging: ⏸ deferred because the service/runtime itself is not ready
- Phase 6 — generic service lifecycle: 🟡 generic renderer and `service_intent` delivery integration implemented; broader adoption waits for real services to become ready
- Phase 7 — admin template editor: ⏳ future work, intentionally not started

A separate continuation checkpoint is maintained at `docs/implementation/messaging-checkpoint-2026-09-16.md`.

## Deployment principle

Do not perform a big-bang replacement. Migrate one message family at a time and compare output/state in TEST/STAGING before enabling the next family.

## Phase 0 — Foundation ✅ implemented

Delivered:

- generic message contracts
- safe deterministic renderer
- account/system template resolver
- domain context builders
- versioned template schema
- immutable account revisions with explicit publication pointer
- validation for required/optional/secret variables
- system-template fallback
- tests and implementation documentation

Migration: `077_message_template_platform.sql`.

System defaults remain reviewed/versioned in code. Account-specific copy is stored only as immutable revisions/publications.

## Phase 1 — Trusted-admin pending approval ✅ implemented

`change_request.pending` renders through the Messaging Platform.

Preserved invariants:

- trusted identity capability check remains authoritative
- idempotent create-change replay receives no historical plaintext PIN and does not resend the approval body
- durable in-app notification remains PIN-free
- malformed/unavailable account override falls back to the reviewed system template
- the template must contain both `{{entity.reference}}` and the declared `{{secret.confirmation_code}}` placeholder
- template resolution logs source/revision/version only; secret values are never logged

Security hardening:

- the secret-bearing approval WhatsApp body does not use `engineSendText`
- it is sent only through the direct trusted-admin Meta transport
- therefore the plaintext approval PIN is not persisted into the CRM `messages` table
- the durable dashboard notification remains available without the PIN if direct WhatsApp delivery fails

Replay safety is anchored at `create_change_request_v2`: an idempotent replay does not return the historical PIN, so the notifier cannot blindly resend it.

## Phase 2 — Admin outcome messages ✅ implemented

Implemented events:

- `change_request.approved`
- `change_request.rejected`

The command parser, authorization checks, approval/rejection RPCs, deterministic executor, and customer delivery status remain authoritative. Templates only control presentation after the business decision.

Detailed contract: `docs/implementation/messaging-phase-2-admin-outcomes.md`.

## Phase 3 — Coverage customer outcomes ✅ implemented; TEST delivery recheck pending

Implemented events:

- `coverage.offer.approved`
- `coverage.request.approved`

Coverage execution emits structured message data. Templates do not classify direction or calculate business truth.

Verified semantic contract:

- SOUTH -> NORTH = offer; customer receives commission (`راجع للعميل` / `الراجع لك`)
- NORTH -> SOUTH = request; customer pays commission (`عمولة` / `العمولة عليك`)
- payment/receive methods do not change direction classification
- authoritative approved amount/rate data remains the source of numbers

Detailed contract: `docs/implementation/messaging-phase-3-coverage-customer-outcomes.md`.

### Customer outbox delivery hardening

During TEST approval of `CHG-5`, the coverage template rendered correctly but the immediate delivery worker reported:

```text
customer notifications claimed=0 sent=0 reconcile=0 failed=0
```

The notification row itself remained `pending` with zero attempts. This was not evidence of a WhatsApp message-window/limit failure: no transport attempt had occurred.

Root cause was an app/database clock-skew race. The previous claim path compared outbox `available_at` against application time. A row created with the PostgreSQL clock could briefly appear to the application as not yet due.

Migration `078_customer_notification_atomic_claim.sql` fixes this by moving eligibility and claim into PostgreSQL:

- eligibility uses `pg_catalog.now()` from the same database clock
- `FOR UPDATE SKIP LOCKED` prevents concurrent workers claiming the same row
- the row moves `pending -> sending` atomically
- attempts/claim token are updated atomically
- RPC execute permission is restricted to `service_role`

The runtime now uses this atomic claim for customer outcome delivery.

**Acceptance still required:** rerun the TEST end-to-end customer delivery after syncing the latest branch and confirm a due outcome is claimed and delivered exactly once.

## Phase 4 — Exchange rates / currency trade ⏸ deferred

Do not continue template/runtime integration for exchange-rate or currency-trade outcomes yet.

Reason: the underlying service/runtime is not considered ready. Template support must follow authoritative service behavior, not lead it or invent a transactional lifecycle.

When the service becomes ready, resume with rules:

- published rate service is authoritative
- template/KB never stores the current price
- buy/sell labels are presentation only; side/rate come from domain logic
- timestamps/source metadata may be added to normalized context when needed
- define events only after the real transactional lifecycle is known

## Phase 5 — Remittances ⏸ deferred

Do not implement remittance lifecycle integration yet.

Reason: the remittance service/runtime is not ready. Events such as `remittance.pending`, `remittance.approved`, `remittance.completed`, and `remittance.rejected` remain design placeholders only until the authoritative remittance lifecycle exists.

Never emit `remittance.completed` while provider delivery/settlement is ambiguous.

## Phase 6 — Generic service adoption 🟡 partially implemented

Generic customer lifecycle templates now include:

```text
service_request.approved
service_request.rejected
service_request.matched
service_request.needs_clarification
service_request.completed
```

The renderer is reusable across future services.

For current `service_intent` outcome delivery, the delivery layer loads authoritative `change_request` state and re-renders supported decisions through the generic service templates immediately before transport. Existing legacy `message_text` remains only as a migration fallback for unsupported/unknown cases.

Current decision mapping:

```text
fulfilled   -> service_request.approved
rejected    -> service_request.rejected
matched     -> service_request.matched
clarifying  -> service_request.needs_clarification
```

`service_request.completed` exists as a generic template contract but must only be emitted by a future service that has a real authoritative completed state.

New services should adopt these generic lifecycle events first, adding specialized templates only when the domain needs additional presentation fields.

## Phase 7 — Admin template editor ⏳ future

Build UI only after runtime correctness is proven for the currently supported message families.

Future editor capabilities:

- list system defaults read-only
- list account revisions
- create a new immutable revision
- preview with safe sample context
- validate required/optional/secret variables
- publish revision
- rollback by publishing an older revision
- unpublish account override to restore system default
- audit who published and when

Never expose secret values in preview fixtures.

## Deferred WhatsApp delivery-policy UX

The following is intentionally **not part of the current template phase**:

- making the WhatsApp customer-service window/eligibility clearer in the conversation UI
- showing transport/window state beside a customer conversation
- a manual retry/resume button or similar operator action
- policies for template-message fallback outside the customer-service window

This should be designed as a separate delivery-policy/operations phase after the current messaging-template acceptance is complete.

## Runtime integration API

Target calling pattern:

```ts
const resolved = await resolveMessageTemplate({
  accountId,
  eventKey,
  audience: 'customer',
  channel: 'whatsapp',
  locale: customerLocale,
  store: createSupabaseTemplateOverrideStore(db),
})

const text = renderMessageTemplate({
  template: resolved.template,
  context,
  secrets,
})
```

Transport remains separate. Normal non-secret operational messages can use `engineSendText` and its idempotency reservation. Secret-bearing trusted-admin approval messages use the direct verified-admin transport so the secret is not persisted.

## Observability

Structured render logs contain metadata only:

```text
[messaging] event=change_request.pending source=system template=change_request.pending locale=ar channel=whatsapp
```

For account overrides include revision/version. Never log rendered secret values.

Monitor:

- template resolution failures
- missing required variables
- unsafe approval-template fallback reasons
- render length failures
- customer outbox pending/sending/sent/reconciliation states
- claim counts and duplicate claims
- transport send failures
- retry/reconciliation counts
- override usage rate

## Failure policy

Transactional messaging fails closed on malformed templates except where an explicitly reviewed system fallback is safer than dropping a security-critical notification.

Runtime behavior:

1. try account override
2. if none exists, use system default
3. if a published security-critical approval override is malformed or the override store is unavailable, use the reviewed system `change_request.pending` template
4. never omit the approval reference or one-time PIN from the trusted-admin approval body
5. never transform a business failure into a success message
6. never persist transient secret values into template storage, durable notifications, or normal CRM message history
7. claim due customer-outbox rows atomically with the database clock
8. do not introduce domain events for services whose authoritative runtime is not ready

## Current acceptance gate before moving on

Before starting exchange rates, remittances, the template editor, or WhatsApp-window UI:

1. sync the latest `test/ai-runtime-kb-tools-v2` branch
2. run one TEST coverage approval end-to-end after migration `078`
3. verify the customer outbox row is claimed exactly once and reaches `sent`, or capture a real transport error if WhatsApp rejects it
4. verify admin outcome rendering remains correct
5. run/confirm CI and migration replay on the resulting branch head
6. record the TEST result in the continuation checkpoint

After these pass, the current template phase can be considered accepted for the services that are actually ready today.

## Production promotion gate

Do not promote the platform to production until:

- all CI checks pass
- full migration replay passes
- TEST/STAGING RLS and grants verified
- approval PIN remains transient end-to-end
- customer/admin messages verified end-to-end
- duplicate-send/idempotency behavior verified
- retry/reconciliation paths verified
- rollback to system defaults demonstrated
- no current prices or secret values are stored in template content
- production deployment is explicitly approved as a separate decision
