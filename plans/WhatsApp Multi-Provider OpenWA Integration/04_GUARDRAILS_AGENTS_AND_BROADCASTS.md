# OW-10 / OW-11 — Guardrails, Agents, Automations, Broadcasts

## OW-10 — Safety & Anti-Abuse Guardrails

OpenWA/WhatsApp Web is unofficial. WACRM must make that operational risk explicit and bounded.

### Required policy controls
- per-connection daily/hourly caps
- minimum send interval and jitter for automated/broadcast workloads
- new-contact/first-touch limits
- failure-rate circuit breaker
- provider restriction/logged-out circuit breaker
- warm-up state for newly linked numbers
- manual emergency pause
- separate limits for manual agent send vs automation/broadcast where appropriate
- audit trail for automatic/manual blocking decisions

### Product behavior
UI must distinguish Meta Cloud API (official) from WhatsApp Web/OpenWA (unofficial linked-device integration). Do not promise ban-proof behavior. Restricted/logged-out connections must not continue agent, automation or broadcast sends.

### Tests
limit boundaries, concurrent reservations, circuit breaker activation/reset, restriction webhook, manual pause, tenant isolation, bypass attempts, Meta policy unaffected.

---

## OW-11 — Agents, Automations & Broadcast Routing

### Goal
Remove provider choice from business callers. Agents/automations request a WhatsApp action against a WACRM connection; transport routing selects provider.

### Existing surfaces to inventory/refactor
- `src/lib/automations/meta-send.ts`
- automation engine callers
- Flow send nodes/workers
- AI auto-reply and multi-agent send tools
- Agent Task/outreach delivery paths
- `src/lib/whatsapp/broadcast-core.ts`
- `src/lib/whatsapp/broadcast-resume.ts`
- WhatsApp broadcast API routes
- public `/api/v1/messages` path

### Rules
- no AI prompt/tool decides `whatsapp-web.js` vs `baileys`.
- WACRM owns campaign recipients, pacing policy, status, pause/resume, audit and idempotency.
- OpenWA bulk/automation subsystems are not used as competing business engines.
- Meta official-template requirements remain enforced on Meta connections.
- OpenWA sends use WACRM content/business templates but not fake Meta approval state.
- capability checks reject unsupported provider features before provider call.

### Broadcast safety
Every recipient send remains individually attributable/idempotent in WACRM. Pause/resume must not duplicate accepted provider sends. Restriction/failure circuit breakers stop subsequent recipients and surface a recoverable campaign state.

### Agent safety
Agent tool execution uses the same authorization, account/connection selection and guardrail path as human/API sends. Provider credentials/session controls are never exposed to model context.

### Tests
- automation text send through each provider
- Flow send through each provider
- agent send through each provider
- broadcast pause/resume and duplicate protection
- restriction mid-broadcast
- unsupported capability
- Meta template regression
- cross-tenant agent/tool attempt

### Exit gate
All business callers are provider-neutral for the MVP message types, OpenWA cannot bypass WACRM guardrails, and the full Meta regression gate remains green.
