# WACRM AI runtime / KB / tools v2 test bundle

This directory is a transport + installer for the repair overlay based on commit `13f83ec`.
It is intentionally on the test branch `test/ai-runtime-kb-tools-v2`; `main` is unchanged.

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
3. applies the semantic repair references in memory before writing project files;
4. copies the overlay (runtime, APIs, migrations 065-067, dynamic KB, tool platform, docs);
5. runs the bundle-local syntax/contract checks when Node is available.

After applying, inspect `git diff` and run the full repository checks:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint
```

Apply migrations `065`, `066`, and `067` to a **test/staging Supabase project first**. Do not apply this branch directly to production before the full checks and the business E2E scenarios pass.

The installer changes your working tree but does not commit or push those applied changes.
