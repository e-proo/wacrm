<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Knowledge base (معرفة المشروع)

This repository ships an internal knowledge base under `plans/`. It is the source of truth for architecture, data contracts, and phased implementation scope. Before working on a matching feature, READ the relevant documents first — do not rely on memory or training data for these topics.

## Multi-provider AI (تعدد مزودي الخدمة)
Start here: `plans/تعدد مزودي الخدمة/WACRM_AI_MultiProvider_Documentation_v1.0/README.md`
- `architecture/TARGET_ARCHITECTURE.md` — provider abstraction, routing, data/API contracts
- `architecture/PROVIDER_COMPATIBILITY_MATRIX.md` + `architecture/DECISIONS.md` (ADRs)
- `prompts/PHASE_00_*.md` … `PHASE_06_*.md` — one implementation prompt per phase; follow them in order
- `delivery/IMPLEMENTATION_ROADMAP.md`, `delivery/TEST_AND_ACCEPTANCE_MATRIX.md`, `delivery/SECURITY_AND_OPERATIONS.md`

## Multi-agent & services department (تعدد الوكلاء وقسم الخدمات)
Start here: `plans/تعدد الوكلاء وقسم الخدمات/00_START_HERE.md`
- `01_TARGET_ARCHITECTURE_AND_MIGRATION.md` … `07_TESTING_SECURITY_RELEASE_RUNBOOK.md` — sequential phases

## Database / backend contracts
- `supabase/migrations/*.sql` — numbered migration history; new schema changes go in a new numbered migration file, never edit old ones.

Rules:
- When a task matches a phase, read that phase document fully and implement exactly its scope.
- Treat these docs as authoritative; if code and docs conflict, surface the conflict instead of silently diverging.
- Do not edit or delete knowledge-base documents unless explicitly asked.
