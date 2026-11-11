# OW-13 Pilot Admission — Server-Controlled Preparation

## OW-13 developer note — Pilot allowlist is deliberately not activated

The OW-13 server-side preparatory implementation uses an inert DB allowlist
(migration `155_openwa_pilot_admission.sql`) and a server-only environment
mode `OPENWA_PILOT_MODE=enforce` which is **never enabled by a migration**.
The default `off` maintains existing OpenWA TEST behavior. Meta always
routes through its existing unchanged adapter.

When `enforce` is explicitly set for a future approved pilot, **every**
outbound OpenWA workload is denied unless a server-only allowlist row matches:
`account_id`, `connection_id`, SHA-256 of the *canonical* provider-native
recipient, workload, `active=true` and `expires_at>now()`.
No allowlist row is created by the migration. Admins/agents do not receive
credentials or unrestricted access to either pilot table; provision only by
an audited, separately reviewed operator workflow after OW-12 acceptance.
The RPC records admit/deny decisions without plaintext phone/JID.

The existing per-connection `pause` and `resume` actions remain admin-only.
The send boundary additionally re-checks the server-side pause after any
guardrail wait and before the provider dispatch. A provider POST *already in
flight* when pause is triggered may still finish. It is never safe to resend
an ambiguous outcome.

**Activation is blocked** until SOF-41 OW-12 live acceptance + SOF-42/44
preflight tests + SOF-43 explicit cohort/operator approval, Meta live regression,
clean-migration replay and emergency stop rehearsal have passed. No production
pilot is authorized by this implementation.
