# WACRM AI runtime / KB / tools v2 test bundle

This directory is the transport and verified installer for the repair overlay based on commit `13f83ec`.
It intentionally lives on the test branch `test/ai-runtime-kb-tools-v2`; `main` remains unchanged.

## Apply on a clean checkout

```bash
git fetch origin
git switch test/ai-runtime-kb-tools-v2
git pull --ff-only origin test/ai-runtime-kb-tools-v2
bash repair/apply-repair-bundle.sh
```

The installer:

1. requires a clean working tree and verifies that `13f83ec` is an ancestor;
2. reconstructs the embedded archive and verifies SHA-256 `41642c849d11fb6182191ad078f7736ba51bd2c998d247a0efb8e3fc223fc834`;
3. applies semantic repair patches `001` through `015` against the verified base;
4. copies the runtime/API/migration/tool-platform overlay, including migrations `065`–`067`;
5. applies the small compatibility/type/lint adjustments discovered by full GitHub CI and synchronizes legacy tests with the repaired runtime contracts.

After applying, inspect `git diff` and run the same repository checks used by Repair Bundle CI:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint
```

The repaired branch contains a synchronized `package-lock.json`, so `npm ci` must succeed directly without regenerating the lockfile.

Apply migrations `065`, `066`, and `067` to a **test/staging Supabase project first**. Do not apply this branch directly to production before the business E2E scenarios pass, including customer coverage offer/request handoff, trusted-admin approval, deterministic execution, exchange-rate changes, admin queries, and idempotent customer notification.

The installer changes your working tree but does not commit or push those applied changes.
