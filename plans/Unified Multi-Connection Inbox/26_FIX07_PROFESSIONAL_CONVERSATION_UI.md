# FIX-07 — Professional Conversation UI Restoration

Status: implementation in progress; CI, TEST, visual and live acceptance not claimed.

Baseline: 8d6a18aa1c89162ea1e7f1f7827a304e431addbb. Existing scoped history contract (217/219) and native action proof (221) are reused. No applied migration modified, no feature gate enabled, no legacy send API introduced.

## First implementation slice
- Scoped history day dividers, bubbles, delivery icons, inline media/document display, quote navigation when the original is loaded, hover/focus/touch-accessible actions.
- Reuse the legacy presentational ReplyQuote, with logical RTL border and contrast correction. Local reply preparation is independent from dispatch; server retains membership/native identity proof.
- Compact composer tools, attachment preview, quick replies, emoji, Meta-only window and template/interactive controls, local text draft while dispatch disabled, guarded action journal, explicit keyboard shortcut.
- Unit fixtures for Meta window, quote bounds and lane matching; Arabic/English/Korean emoji label.

## Outstanding gates
- Verify inbound reply binding from live OpenWA/Meta (IN-06); if data missing, investigate canonical ingress before introducing additive schema change.
- Complete voice recording integration with the existing Opus encoder and safe staged upload lifecycle; audit attachment retention across navigation, permission changes and uncertain outcomes.
- Visual desktop/mobile/keyboard, dark/light, RTL/LTR/Korean acceptance; long-press behavior and full regression.
- Full CI + TEST verification, UI-T01–09 and LIVE-T01–03. Do not mark SOF-90 or SOF-81 closed from this implementation alone.
