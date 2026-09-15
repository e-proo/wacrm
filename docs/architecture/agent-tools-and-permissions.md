# Agent Tools, Permissions, and Domain Registry

## Goal

Every agent tool in WACRM must have one machine-checkable contract that describes both how the model should use it and how the runtime authorizes it. Tool descriptions, grants, and policy must not drift into separate hand-maintained lists.

The canonical contract is `PlatformToolManifest` in:

`src/lib/ai/tools/platform/contracts.ts`

Current legacy tools are bridged through `current-domain-registry.ts`. New domains should define native platform manifests directly.

## Three operation classes

### READ

- no authoritative side effect;
- may be model exposed;
- returns account-scoped safe DTOs;
- examples: service lookup, quote calculation, current exchange-rate read.

### PROPOSE

- may be model exposed only when policy permits;
- creates a typed, replay-safe proposal/change request;
- does **not** mutate authoritative business data;
- high/critical proposals require human approval.

### EXECUTE

- authoritative write;
- **never model exposed**;
- server-only deterministic handler;
- runs only after the approval engine has accepted a typed proposal;
- must be replay safe and audited.

The model flow is therefore:

```text
READ -> answer
PROPOSE -> typed Change Request -> human approval -> deterministic EXECUTE
```

A model never receives an `execute` grant.

## Required tool manifest fields

Every tool must define:

- stable `key` and positive `version`;
- `domain` and human title;
- purpose/description;
- `whenToUse`;
- `whenNotToUse`;
- input and output schema;
- permission (`read|propose|execute`);
- risk level;
- allowed runtime planes (`customer|admin`);
- required trusted-admin capabilities;
- supported grant constraints;
- side-effect classification;
- whether explicit approval is required;
- idempotency semantics;
- audit policy;
- model exposure/server-only flag;
- examples and bounded error contract.

`validateToolManifest()` rejects structurally unsafe combinations, including a model-exposed authoritative write tool.

## Runtime authorization intersection

A tool call succeeds only when all layers agree:

```text
tool exists at exact version
AND manifest allows the runtime plane
AND frozen revision grant matches exact tool/version/permission
AND account runtime feature policy enables tools/proposals
AND agent purpose matches plane
AND trusted admin identity exists when plane=admin
AND trusted admin has every required capability
AND grant constraints are understood and pass
AND simulation rules allow the operation
```

Unknown tools, unknown constraints, stale versions, or missing manifests fail closed.

## Customer vs admin plane

Customer plane:

- may read customer-safe business data;
- may create typed customer-originated proposals/intents;
- never receives authoritative writes;
- cannot choose contact/account/conversation IDs when these are server context.

Admin plane:

- requires a verified trusted-admin identity;
- every model-exposed admin tool declares a capability such as `rates.propose`;
- proposals still require approval when the manifest says so;
- admin identity does not bypass deterministic execution.

## How the model learns when to use a tool

Provider-facing tool descriptions are generated with `renderToolUsageDescription()` from the same manifest used by runtime authorization. They include:

- description;
- “Use when” conditions;
- “Do not use when” conditions;
- approval warning when applicable.

This prevents prompt docs from becoming a second policy source.

## Grant constraints

Only constraints actually implemented by runtime may be advertised. Currently repaired runtime enforces:

- `channels`
- `service_ids`
- `currencies`

A new constraint must first receive an enforcement implementation and tests. Do not add metadata such as `regions` merely because it would be useful; unsupported constraints fail closed.

## Domain registry

Tools are grouped into versioned domain modules. Examples:

- `services`
- `pricing`
- `pricing_rules`
- `exchange_rates`
- `coverage`
- `intents`
- `change_requests`

A domain owns its contracts, service layer/executors, policies, and tests. Exact tool-version executors are registered through `ToolExecutorRegistry`; the central dispatcher must not grow a domain-specific `switch (toolKey)`. New functionality should extend a domain or create a new domain, then register its manifest and executor together.

## Versioning

Change tool version when a change can alter model/runtime compatibility, including:

- required/removed/renamed argument;
- output contract change;
- permission or side-effect change;
- materially changed meaning.

Keep the old version executable only while published revisions may still reference it. Publishing validation must reject stale/unregistered grants.
