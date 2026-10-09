# Tool Contract Review Checklist

Use this checklist in code review for every new/changed agent tool.

## Identity and tenancy

- [ ] `account_id` comes from server runtime, not model arguments.
- [ ] Contact/conversation/inbound-message identity is server-bound where applicable.
- [ ] Every selected resource is account scoped.
- [ ] DB constraints/triggers prevent cross-tenant relationships.

## Manifest

- [ ] Stable namespaced key and explicit version.
- [ ] Correct domain.
- [ ] Description explains the operation, not policy promises.
- [ ] At least one `whenToUse` rule.
- [ ] At least one `whenNotToUse` rule.
- [ ] Input/output contracts are bounded.
- [ ] Plane is explicit.
- [ ] Admin model tool has required capability.
- [ ] Only runtime-enforced grant constraints are advertised.
- [ ] Error codes distinguish safe user-facing errors from internal errors.

## Side effects

- [ ] READ has no side effect.
- [ ] PROPOSE only creates a typed/replay-safe proposal.
- [ ] EXECUTE is server-only and not model-exposed.
- [ ] High/critical proposal requires human approval.
- [ ] Authoritative writes are deterministic.
- [ ] Expected-version/CAS is used when stale writes matter.
- [ ] Idempotency key prevents duplicate mutation.
- [ ] Audit records are emitted.

## Data exposure

- [ ] Customer DTO excludes internal/private fields by construction.
- [ ] Admin-only DTO cannot be selected on customer plane.
- [ ] Raw database rows are not returned without projection.
- [ ] Secrets/tokens/internal prompts never enter tool results.

## Registration and dispatch

- [ ] Exact `tool_key@version` manifest is registered.
- [ ] Exact `tool_key@version` executor is registered.
- [ ] No domain-specific central dispatch switch case was added.
- [ ] Missing executor fails closed.

## Runtime tests

- [ ] exact grant + version works;
- [ ] wrong version fails;
- [ ] wrong permission fails;
- [ ] wrong plane fails;
- [ ] missing capability fails;
- [ ] simulation blocks proposals/writes;
- [ ] unsupported constraint fails closed;
- [ ] malformed args fail;
- [ ] retry does not duplicate proposal/write;
- [ ] executor cannot be emitted to provider tool catalog.
