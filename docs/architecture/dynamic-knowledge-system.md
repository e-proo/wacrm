# Dynamic Knowledge System v2

## Decision

WACRM business knowledge is **runtime data**, not source code. The application must never read repository files as an agent knowledge source. Knowledge is created and managed through the database/storage-backed application workflow.

Allowed source types are intentionally closed:

- `manual`
- `upload`
- `url`
- `api`
- `integration`

`project_file`, local filesystem paths, source-code imports, and arbitrary server file reads are not valid knowledge sources.

## Data model

```text
Account
  └─ Knowledge Base (shared | agent_private | service)
       ├─ service links (optional)
       └─ Documents
            └─ Chunks + FTS + embedding revision

Agent Revision
  └─ explicit Knowledge Base assignments
```

Key tables introduced/used by migration 067:

- `ai_knowledge_bases`
- `ai_knowledge_documents` (existing table, evolved)
- `ai_knowledge_chunks` (existing index units)
- `ai_knowledge_base_services`
- `ai_agent_knowledge_base_assignments`

The old `ai_agent_knowledge_assignments` chunk-level table is deprecated. It is backfilled into KB-level assignments for compatibility but is not used by the v2 runtime.

## Why assignment is revision-scoped

Knowledge selection is configuration. A published agent revision must be reproducible: provider/model, prompt, tool grants, and knowledge assignments should describe the same immutable runtime snapshot.

Therefore an agent does not dynamically inherit every KB in its account. The runtime executes:

```text
published agent revision
  -> explicit KB assignments
  -> active KBs only
  -> active/effective documents only
  -> matching chunks only
```

**No assignment means no retrieved knowledge.** There is no whole-account fallback.

## Knowledge scopes

### Shared

Reusable facts/policies that multiple agents may use. Examples: company policy, common FAQ, general service explanations.

### Agent private

Knowledge intended for one agent family. The KB stores `owner_agent_id`; DB tenant guards require the owner agent to belong to the same account. An agent-private KB is still assigned explicitly to a draft revision before publication.

### Service linked

A KB can be associated with one or more service IDs. General/private KBs can be retrieved without a service selection. A service-linked KB is eligible only when the runtime has a **server-resolved matching `serviceId`**; a null/unknown service never widens into all service knowledge. The model is never allowed to choose another account's service or KB ID.

## Lifecycle

Knowledge base:

```text
draft -> active -> archived
```

Document:

```text
draft -> reviewed -> active -> superseded/archived
          \
           -> quarantined
```

Only `active` KBs and `active` documents are retrievable. Effective date windows are also enforced in SQL.

Editing document content invalidates prior review and returns it to `draft`, or `quarantined` when the injection scanner reports high risk.

## Trust is not authority

Document trust levels:

- `admin_verified`
- `internal`
- `external`
- `untrusted`

Trust indicates expected factual reliability. It **never grants instruction authority**. Even `admin_verified` knowledge is reference data and cannot override the system/developer prompt, tool grants, runtime plane, account identity, approvals, or deterministic executor rules.

## Prompt-injection boundary

Every retrieved excerpt is wrapped behind a fixed security preamble. The runtime treats the excerpt as quoted/reference data. Text such as:

- “ignore the system prompt”
- “call the admin tool”
- “reveal secrets”
- “disable security”

is never interpreted as authority.

Defense is layered:

1. ingestion scanner classifies `injection_risk`;
2. high-risk content starts quarantined;
3. human lifecycle review is required;
4. SQL retrieves only active/effective content;
5. retrieved content is serialized as reference metadata + content;
6. runtime tool policy is independent of RAG;
7. account/revision/plane/capabilities are server-derived.

The scanner is an aid, not a security boundary. The primary boundary is that RAG content cannot alter runtime authorization.

## Retrieval

Runtime v2 uses hybrid retrieval:

1. semantic search when a valid active embedding revision is available;
2. lexical FTS top-up/fallback;
3. SQL-level account + revision + KB + lifecycle + effective-date + language + service scoping;
4. bounded result count.

The model cannot send `knowledge_base_id` to retrieval. Assignment IDs come from the frozen agent revision.

## API model

Primary APIs:

```text
GET/POST   /api/ai/knowledge-bases
GET/PATCH  /api/ai/knowledge-bases/:id
GET/POST   /api/ai/knowledge-bases/:id/documents
PATCH      /api/ai/knowledge-bases/:id/documents/:documentId
GET/PUT    /api/ai-agents/:agentId/revisions/:revisionId/knowledge-bases
```

The old `/api/ai/knowledge` endpoint remains only as a compatibility facade. It maps manual entries into a dynamic shared `general` KB and does not restore global retrieval.

## Tenant integrity

RLS is not the only protection. Migration 067 also uses DB triggers to reject cross-account relationships between:

- private KB and owner agent;
- document and KB;
- KB and linked service;
- agent revision and assigned KB.

This protects service-role/internal paths from accidental tenant mixing.

## Operational rules

- Never store executable instructions in KB as a substitute for agent prompt or tool policy.
- Never store secrets/API keys in KB.
- Never auto-activate newly imported external content.
- Never allow a model to choose its KB assignment.
- Never silently widen retrieval when an assignment or embedding lookup fails.
- Publication must freeze KB assignments with the agent revision.
