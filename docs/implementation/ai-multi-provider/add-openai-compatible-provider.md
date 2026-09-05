# Add a provider (WACRM)

**Audience:** developers/operators extending the AI multi-provider layer.
**Phases:** 03 + 04. **Rule proven here:** adding a compatible provider is
**one declarative entry + fixtures** — never a change to generation logic.

## 0. Protocol matrix

| Protocol id | Adapter | Providers | Status |
|---|---|---|---|
| `openai` | `providers/openai.ts` | OpenAI, DeepSeek, OpenRouter-like | chat + `GET models` optional |
| `anthropic` | `providers/anthropic.ts` | official Anthropic | chat + `/v1/models` cursor pagination |
| `gemini_native` | `providers/gemini.ts` | Google AI Studio | generateContent + native list + embed seam |

## 1. Supported compatibility subset (all protocols)

| Capability | Status | Notes |
|---|---|---|
| Non-streaming chat/completions | ✅ | one system prompt + `user/assistant` history |
| `GET models` catalog | ✅ optional | per-protocol normalizer, 500-model / 5-page / 2 MB caps |
| Per-model verification probe | ✅ | `POST …/test-model`, explicit only |
| `embed` method contract | 🔒 seam | adapter-level only; KB wiring is Phase 05 + 1536 gate |
| Streaming / tools / function calling / multimodal / batch | ❌ | ADR-010 — needs new story + ADR |


The stored `api_root` is the **complete versioned/un-versioned root**
(Master §9.4); the adapter never appends `/v1` itself, and
`joinApiPath` collapses an accidental `/v1/v1` exactly once.

## 2. Add a preset (three steps)

1. **Verify the provider's current official OpenAI-compatible base URL**
   from its own docs — record the URL and the date you checked it.
2. **Declare it** in `src/lib/ai/providers/presets.ts`:

```ts
{
  id: 'newproxy',                      // stable, server-defined
  label: 'New Proxy',
  protocol: 'openai',                  // reuse the existing adapter
  defaultApiRoot: 'https://api.newproxy.example/v1/', // trailing slash
  apiRootMode: 'fixed',                // 'custom' => deployment-gated only
  authStrategy: 'bearer',
  availability: 'public',              // or 'deployment_opt_in'
}
```

3. **Add a contract fixture** in
   `src/lib/ai/providers/openai.test.ts` (follow the
   “DeepSeek-like compatible root” test) asserting the chat and models
   URLs join onto the new root, plus any known deviations (e.g. no
   `/models`).

**Do not** touch `generate.ts`, `registry.ts`, or call-site code. If a
provider needs anything beyond §1's subset, that needs an ADR first.

### 2b. Add a native-protocol adapter (Anthropic / Gemini precedent)

A NEW protocol (not compatible with an existing adapter) requires:
- `ProviderProtocol` extension + registry entry (no brand branches in
  consumers — the registry lookup IS the dispatch);
- a lockstep additive CHECK widen in migrations (see 041);
- its own contract tests with a stubbed transport (zero network);
- official metadata only for capability classification (for Gemini:
  `supportedGenerationMethods`, never names; ADR-005).

Anthropic-compatible gateways are deferred by product scope (ADR-007
deployment policy): until an approved custom endpoint exists, the
`anthropic` preset remains the only Anthropic-shape connection.

### 2c. Where model ids come from (Gemini)

Gemini ids are stored and matched BOTH ways: display bare
(`gemini-2.5-flash`), raw kept internally (`models/gemini-2.5-flash`);
`normalizeGeminiId()/geminiPathSegment()` tolerate either so hand
copied `models/...` from API console never double-prefixes a URL.

## 3. Custom / private gateways (9Router-style), self-hosted

Any gateway speaking an official request shape works TODAY with no
code at all: create a connection of one of the three `Custom —
<protocol>-compatible` presets and enter the root, e.g.
`https://api.b.ai/v1/` (OpenAI-shape) or `https://gw.example/anthropic/v1/`
(Anthropic-shape).

Enforcement chain (all already shipped, Phases 02–05):

1. **Visibility gate:** custom presets appear in
   `GET /api/ai/provider-presets` and pass POST validation ONLY while
   the deployment sets `AI_CUSTOM_ENDPOINTS_ENABLED=true` (tenant
   admins cannot toggle it — ADR-007).
2. **Save gate:** `normalizeRoot` rejects non-https / oversized /
   malformed roots at create/patch.
3. **Request gate:** custom connections carry a server-derived
   `customEndpoint` flag through `loadRuntimeConnection`; EVERY adapter
   call (chat / embeddings / discovery — `providerFetch` in
   `providers/shared.ts`) then validates scheme/port/credentials and
   classifies DNS answers — ANY private/loopback/metadata/CGNAT answer
   blocks the request, redirects are refused (`3xx`), and unresolvable
   hosts fail closed. Fixed preset roots skip this path untouched.
4. **LAN gateways:** to point at genuinely private hosts (e.g. 9Router
   on your network) the operator additionally sets
   `AI_PRIVATE_ENDPOINTS_ENABLED=true` plus
   `AI_ENDPOINT_ALLOWLIST=gw.internal.example:443` (exact host[:port],
   no wildcards) and MUST provide network isolation (docs §4.4).

## 4. Model-name policy

No model IDs are hard-coded as an allowlist anywhere: stored models
are accepted on faith with a verification probe, and discovery results
are advisory (`unknown` capability ≠ unusable). A model that disappears
from a catalog is never auto-deleted — it stays in the UI pinned as
"saved / not in latest catalog."
