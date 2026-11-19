# NOTE-001 — Supabase TEST Security Advisor final Auth gate

**Date:** 2026-11-19  
**Scope:** WACRM TEST only (`pqirsnfupofhulmewakq`). No Production changes.  
**Status:** Database findings TEST verified at zero; hosted Auth password gate still pending operator configuration.

## Verified database result

The following warnings were eliminated by additive migrations:

- `198_anon_security_definer_acl_hardening.sql`: anonymous callable SECURITY DEFINER routines **22 → 0** (completed 2026-11-18).
- `199_authenticated_definer_private_facades.sql`: authenticated callable public SECURITY DEFINER routines **11 → 0**. Public RPC signatures remain, but are SECURITY INVOKER; original privileged implementations reside under `wacrm_internal` and keep their account authorization.
- `200_server_only_rls_searchpath_and_vector.sql`: 13 server-only tables receive explicit **service_role-only** RLS policies (never anon/authenticated grants), 16 function `search_path` settings pinned, and pgvector relocated from `public` to `extensions` while retaining legacy/V2 semantic queries.
- `201_private_message_template_actor_guard.sql`: the three private template engines enforce a verified actor (or trusted service/migration context) even if called outside their public facades.

**CI evidence:** [Migrations SUCCESS](https://github.com/e-proo/wacrm/actions/runs/44551456706), [CI SUCCESS](https://github.com/e-proo/wacrm/actions/runs/44551456757), including `supabase/ci/security-advisor-note001-completion-smoke.sql` and the previous security/RLS regression suite.

**TEST evidence:** remote migration ledger includes `20261119151254` (199), `20261119151312` (200) and `20261119151318` (201). Immediately after application, `get_advisors(security)` returned just one warning: `auth_leaked_password_protection=1`.

## Final action for TEST project owner

This switch belongs to the **Supabase Auth hosted service**, not PostgreSQL migrations. The available Supabase connection does not support updating hosted Auth settings. Do not attempt to edit `auth.users`, Auth's private database tables, or suppress the linter instead.

1. Open [TEST project's Authentication settings](https://supabase.com/dashboard/project/pqirsnfupofhulmewakq/auth/providers).
2. Go to the **Email** provider / password security settings.
3. Enable **Prevent use of leaked passwords** and save.
4. If unavailable, confirm the Supabase project is on **Pro or above**; according to official documentation the feature requires that plan. Do not assume the ChatGPT subscription affects this.
5. Re-run the Supabase **Security Advisor** for **the TEST project**. Require `auth_leaked_password_protection=0` **and no other security lints**.
6. Verify weak/pwned password signup/reset is rejected by Auth and a strong password succeeds, without testing with real user credentials.
7. Attach the after-state, date and authorized operator to Linear SOF-50 and update NOTE-001.

**Do not claim all security findings equal zero until the advisor confirms it.** Database hardening does not replace OW-14 deployment/live acceptance, credential-rotation rehearsal, security debt review or explicit Production authorization.

Official reference: https://supabase.com/docs/guides/auth/password-security
