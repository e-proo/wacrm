# FIX-07 — Professional Conversation UI Restoration

Status: implementation in progress; Full CI, visual and live acceptance not claimed. Tracking: [SOF-91](https://linear.app/eproo/issue/SOF-91/fix-07-professional-conversation-ui-restoration).

Baseline: 8d6a18aa1c89162ea1e7f1f7827a304e431addbb. Existing scoped history contract (217/219) and native action proof (221) are reused. No applied migration modified, no feature gate enabled, no legacy send API introduced.

## First implementation slice
- Scoped history day dividers, bubbles, delivery icons, inline media/document display, quote navigation when the original is loaded, hover/focus/touch-accessible actions.
- Reuse the legacy presentational ReplyQuote, with logical RTL border and contrast correction. Local reply preparation is independent from dispatch; server retains membership/native identity proof.
- Compact composer tools, attachment preview, quick replies, emoji, Meta-only window and template/interactive controls, local text draft while dispatch disabled, guarded action journal, explicit keyboard shortcut.
- Unit fixtures for Meta window, quote bounds and lane matching; Arabic/English/Korean emoji label.

## Second implementation slice
- Scoped voice capture with existing Ogg/Opus worker; no legacy dispatch, explicit upload/send separation.
- Tab-memory staged attachment restoration separated from text draft storage. Account/user/thread/channel isolation, account-bound upload, no automatic remote deletion on navigation or uncertain outcomes.
- Long-press reply preparation, immediate send lock, read-only draft controls and no route switching during recording/upload.

## Final implementation review
- Keep unrelated unsent text when a non-text action is accepted or reconciled; the request journal stores only the additional non-sensitive action mode. No new key on uncertain outcomes. Text Send control is adjacent to the input; desktop Enter and Ctrl/Command+Enter submit, Shift+Enter stays multiline. Mobile header uses a compact accessible details button.
- Added source-contract fixtures for the scoped action boundary, voice upload-only behavior and translation completeness.

## Read-only TEST evidence (2026-11-27)
- Joined messages to scoped memberships and their account-owned conversations, aggregated by provider (no content or contact identifiers retrieved): OpenWA inbound 13, inbound replies with stored reference 0, same-thread replies 0. No Meta group returned. This is a data-availability finding, NOT a failed rendering assertion or a successful IN-06 test.
- Current normalizer carries explicit native reply IDs and canonical ingress passes them to the transaction. Scoped read contract exposes a reply only when the parent is present in the same lane. Do not infer a missing native ID, silently bind across sessions, or backfill historical quotes without evidence. A new signed reply to a known visible same-session parent is required to localize any remaining gateway/ingress gap.

## Outstanding gates
- Verify inbound reply binding from live OpenWA/Meta (IN-06); if data missing, investigate canonical ingress before introducing additive schema change.
- Verify the new scoped Opus recorder (5-minute cap, explicit staged file, no direct send), cancellation, mic permissions and account-bound upload on TEST. Verify staged attachment retention across in-app navigation, uncertain outcome reconciliation, and account exit. Volatile draft memory intentionally does not survive a full browser reload; the request journal does. Storage objects are not deleted on expiry/navigation/logout to avoid deleting an in-flight provider payload; abandoned staged objects may need separately designed garbage collection.
- Visual desktop/mobile/keyboard, dark/light, RTL/LTR/Korean acceptance; long-press behavior (550ms touch hold, cancellation on motion, accessible Reply button) and full regression.
- Full CI + TEST verification, UI-T01–09 and LIVE-T01–03. Do not mark SOF-90 or SOF-81 closed from this implementation alone.
