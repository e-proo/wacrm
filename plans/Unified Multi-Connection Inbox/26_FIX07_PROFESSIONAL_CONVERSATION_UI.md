# FIX-07 — Professional Conversation UI Restoration

Status: implementation in progress; CI, TEST, visual and live acceptance not claimed.

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

## Outstanding gates
- Verify inbound reply binding from live OpenWA/Meta (IN-06); if data missing, investigate canonical ingress before introducing additive schema change.
- Verify the new scoped Opus recorder (5-minute cap, explicit staged file, no direct send), cancellation, mic permissions and account-bound upload on TEST. Verify staged attachment retention across in-app navigation, uncertain outcome reconciliation, and account exit. Volatile draft memory intentionally does not survive a full browser reload; the request journal does. Storage objects are not deleted on expiry/navigation/logout to avoid deleting an in-flight provider payload; abandoned staged objects may need separately designed garbage collection.
- Visual desktop/mobile/keyboard, dark/light, RTL/LTR/Korean acceptance; long-press behavior (550ms touch hold, cancellation on motion, accessible Reply button) and full regression.
- Full CI + TEST verification, UI-T01–09 and LIVE-T01–03. Do not mark SOF-90 or SOF-81 closed from this implementation alone.
