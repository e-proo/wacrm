# TEST Inbox — verified channel enrollment and Unknown lane

Observed 2026-11-25 on `pqirsnfupofhulmewakq` (read-only inspection):
- 726 original messages, 1 new OpenWA inbound in the prior 48 hours from a registered non-archived `ready` connection.
- 0 verified channels, 0 current membership epochs, 0 scoped threads, 0 scoped message memberships, 0 canonical messages. Thus Active has no attributed messages; Unknown is the correct fail-closed lane.
- Historical and recent message content/IDs were not copied into this report. No TEST/Production writes, sends or worker dispatch occurred during diagnosis.

## Why readiness alone cannot scope messages
OpenWA `ready` is only a registry/transport state. Inbox requires an authenticated exact-provider identity, a durable channel membership epoch, and fresh signed canonical inbound proof. Previous instructions enabled only `WACRM_INBOX_READ_API=test_only` and `WACRM_INBOX_SCOPED_UI=test_only`; this cannot turn legacy inbound into scoped evidence.

## Safe operator procedure (TEST only)
1. Ensure current code is checked out from `refactor/service-platform-v2` and Supabase URL points **exactly** at the pinned TEST project.
2. For read-only visual checking, use `npm run dev:next`; leave `WACRM_INBOX_ACTIONS=off`. Stop independent workers before testing.
3. Add server-only `WACRM_INBOX_SHADOW_ENROLLMENT=true` for explicit admin enrollment. Open `/inbox?scope=active`, expand Session diagnostics, find the ready unverified connection and select **Verify channel identity**. Server queries the authenticated OpenWA/Meta provider and performs tenant-scoped verification. It does not send or change primary automatically. If this fails, check gateway status, credential/version match and the server log; never synthesize identity from a phone string or LID.
4. Inspect that `whatsapp_channels` and `whatsapp_channel_memberships` now contain a current verified epoch and the new channel appears under Active. **There may still be zero scoped threads** at this point.
5. After separate review of the safety gates, on this authorized TEST instance enable `WACRM_INBOX_CANONICAL_INGRESS=test_only` for future signed OpenWA inbound, while leaving outbound actions off. Restart server and use one explicitly authorized owned test sender to provide a fresh inbound message. Check `inbox_canonical_messages`, `inbox_message_memberships` and `inbox_threads` for one attributed message and the expected channel. No blind retry or outbound required. Meta signed ingress has a separate guarded RPC path; verify provider-specific eligibility and semantics.
6. If fresh signed inbound is deferred for unknown LID/native identity, investigate the durable review queue; do not guess a sender phone from `@lid`.
7. Keep old 726 unassigned messages in Unknown unless contemporaneous, independently verified native evidence proves the original channel+epoch. Running an indiscriminate phone/connection based SQL UPDATE is prohibited.
8. Record screenshots, account alias, HEAD, TEST ledger, PASS/FAIL/BLOCKED for SOF-90 and/or SOF-81 as appropriate. Do not close visual/live gates from this code-only repair.

No automatic channel enrollment at connection creation has been approved: explicit admin action is preserved. The GUI merely exposes the already existing server verification endpoint.
