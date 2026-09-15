#!/usr/bin/env python3
from __future__ import annotations
import base64, hashlib, os, pathlib, shutil, subprocess, sys, tarfile, tempfile

BASE_COMMIT = '13f83ecd386fe8d712bd7589df94da2537c7805e'
EXPECTED_SHA256 = '41642c849d11fb6182191ad078f7736ba51bd2c998d247a0efb8e3fc223fc834'
PART_NAMES = [f'wacrm_repair_bundle.tgz.b64.part{i:02d}' for i in range(15)]

class ApplyError(RuntimeError):
    pass

def run(*args: str, cwd: pathlib.Path | None = None) -> str:
    p = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise ApplyError(f"command failed: {' '.join(args)}\n{p.stderr.strip()}")
    return p.stdout.strip()

def git_root() -> pathlib.Path:
    return pathlib.Path(run('git','rev-parse','--show-toplevel')).resolve()

def parse_patch(path: pathlib.Path):
    files: list[tuple[str,list[list[str]]]] = []
    current_path: str | None = None
    hunks: list[list[str]] = []
    current_hunk: list[str] | None = None
    def flush_hunk():
        nonlocal current_hunk
        if current_hunk is not None:
            hunks.append(current_hunk)
            current_hunk = None
    def flush_file():
        nonlocal current_path, hunks
        flush_hunk()
        if current_path is not None:
            files.append((current_path, hunks))
        current_path = None; hunks = []
    for line in path.read_text('utf-8').splitlines():
        if line.startswith('diff --git '):
            flush_file()
            parts = line.split(' ')
            if len(parts) < 4 or not parts[2].startswith('a/'):
                raise ApplyError(f'bad diff header in {path}: {line}')
            current_path = parts[2][2:]
        elif line.startswith(('--- ','+++ ')):
            continue
        elif line.startswith('@@'):
            flush_hunk(); current_hunk = []
        elif current_hunk is not None and line[:1] in (' ','+','-'):
            current_hunk.append(line)
    flush_file()
    return files

def brace_close(text: str, start: int) -> int | None:
    """Find matching } for first { at/after start, ignoring common JS/TS strings/comments."""
    i = text.find('{', start)
    if i < 0: return None
    depth = 0; quote = None; template = False; line_comment=False; block_comment=False; esc=False
    j = i
    while j < len(text):
        c = text[j]; n = text[j+1] if j+1 < len(text) else ''
        if line_comment:
            if c == '\n': line_comment=False
        elif block_comment:
            if c=='*' and n=='/': block_comment=False; j += 1
        elif quote:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c==quote: quote=None
        elif template:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c=='`': template=False
        else:
            if c=='/' and n=='/': line_comment=True; j += 1
            elif c=='/' and n=='*': block_comment=True; j += 1
            elif c in ('\"', "'"): quote=c
            elif c=='`': template=True
            elif c=='{': depth += 1
            elif c=='}':
                depth -= 1
                if depth == 0: return j
        j += 1
    return None

def occurrences(text: str, needle: str, start: int = 0):
    if needle == '': return [start]
    out=[]; p=text.find(needle,start)
    while p >= 0:
        out.append(p); p=text.find(needle,p+1)
    return out

def replace_unique(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise ApplyError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)

def replace_import_block(text: str, module: str, replacement: str, label: str) -> str:
    end_marker = f"}} from '{module}'"
    end = text.find(end_marker)
    if end < 0:
        raise ApplyError(f'{label}: import end not found for {module}')
    end = text.find('\n', end)
    if end < 0: end = len(text)
    else: end += 1
    start = text.rfind('import {', 0, end)
    if start < 0:
        raise ApplyError(f'{label}: import start not found for {module}')
    return text[:start] + replacement.rstrip('\n') + '\n' + text[end:]

def adapt_patch_to_base(patch_name: str, rel: str, content: str, hunks: list[list[str]]):
    """Bridge deliberate semantic references that target a newer call shape than 13f83ec."""
    if patch_name == '010_routing_signals.patch' and rel == 'src/app/api/whatsapp/webhook/route.ts':
        content = replace_unique(
            content,
            "          config.account_id,\n          // Audit / sender-of-record",
            "          config.account_id,\n          config.id,\n          // Audit / sender-of-record",
            'routing signals: processMessage call inboxId',
        )
        content = replace_unique(
            content,
            "  accountId: string,\n  // Sender-of-record for inserts",
            "  accountId: string,\n  inboxId: string,\n  // Sender-of-record for inserts",
            'routing signals: processMessage signature inboxId',
        )
        filtered=[]
        for h in hunks:
            old='\n'.join(line[1:] for line in h if line[:1] in (' ','-'))
            if (
                'await processMessage({' in old
                or 'async function processMessage({' in old
                or old.strip() in {'accountId,', '}: {', 'accountId: string'}
            ):
                continue
            filtered.append(h)
        hunks=filtered
    if patch_name == '015_manifest_driven_tool_dispatch.patch' and rel == 'src/lib/ai/runtime/dispatch.ts':
        content = replace_import_block(
            content,
            '../tools/executors',
            "import type { ToolContext, ToolResult } from '../tools/executors'",
            'manifest dispatcher: executors import',
        )
        content = replace_import_block(
            content,
            '../tools/business-handoff',
            "import { executeCurrentPlatformTool } from '../tools/platform/current-executor-registry'",
            'manifest dispatcher: business handoff import',
        )
        marker = "  const startedAt = Date.now()\n  let result: ToolResult\n  try {\n"
        begin = content.find(marker)
        if begin < 0:
            raise ApplyError('manifest dispatcher: execution block start not found')
        body_start = begin + len(marker)
        catch = content.find('  } catch (err) {', body_start)
        if catch < 0:
            raise ApplyError('manifest dispatcher: catch block not found')
        content = (
            content[:body_start]
            + '    result = await executeCurrentPlatformTool(ctx, tool, invocation.args)\n'
            + content[catch:]
        )
        hunks = []
    return content, hunks

def apply_semantic_patch(content: str, hunks: list[list[str]], label: str) -> str:
    cursor = 0
    last_anchor = 0
    for idx, h in enumerate(hunks, 1):
        old_lines=[]; new_lines=[]; changed=False
        for line in h:
            prefix=line[:1]; body=line[1:]
            if prefix in (' ','-'): old_lines.append(body)
            if prefix in (' ','+'): new_lines.append(body)
            if prefix in ('+','-'): changed=True
        old='\n'.join(old_lines); new='\n'.join(new_lines)
        if not old_lines:
            raise ApplyError(f'{label}: hunk {idx} has no anchor')

        candidates = occurrences(content, old, cursor)
        pos = None
        if len(candidates) == 1:
            pos = candidates[0]
        elif len(candidates) > 1:
            if old.strip() == '}' and last_anchor < len(content):
                close = brace_close(content, last_anchor)
                if close is not None:
                    line_start = content.rfind('\n', 0, close) + 1
                    for c in candidates:
                        if c == line_start or c <= close < c + len(old):
                            pos = c; break
            if pos is None:
                pos = candidates[0]
        else:
            anywhere = occurrences(content, old, 0)
            if len(anywhere) == 1:
                pos = anywhere[0]
            elif old.strip() == '}' and last_anchor < len(content):
                close = brace_close(content, last_anchor)
                if close is not None:
                    line_start = content.rfind('\n',0,close)+1
                    line_end = content.find('\n',close)
                    if line_end < 0: line_end=len(content)
                    actual=content[line_start:line_end]
                    if actual.strip()=='}':
                        pos=line_start; old=actual
            if pos is None:
                excerpt = old.replace('\n','\\n')[:180]
                raise ApplyError(f'{label}: hunk {idx} anchor not found unambiguously: {excerpt!r}')

        last_anchor = pos
        if changed:
            content = content[:pos] + new + content[pos+len(old):]
            cursor = pos + len(new)
        else:
            cursor = pos + len(old)
    return content

def post_apply_type_fixes(root: pathlib.Path) -> None:
    """Small compile fixes discovered only after applying the full bundle to 13f83ec."""
    eval_path = root / 'src/app/api/ai-agents/[id]/revisions/[revisionId]/evaluate/route.ts'
    text = eval_path.read_text('utf-8')
    text = replace_unique(
        text,
        "        contactId: null,\n        plane: testCase.plane,",
        "        contactId: null,\n        conversationId: null,\n        sourceMessageId: null,\n        plane: testCase.plane,",
        'evaluation simulation context',
    )
    text = replace_unique(
        text,
        "        const role = row.role === 'assistant' ? 'assistant' : 'user'\n        return { role, content: typeof row.content === 'string' ? row.content.trim() : '' }",
        "        const role: ChatMessage['role'] = row.role === 'assistant' ? 'assistant' : 'user'\n        return { role, content: typeof row.content === 'string' ? row.content.trim() : '' }",
        'evaluation ChatMessage role',
    )
    eval_path.write_text(text, 'utf-8')

    policy_path = root / 'src/lib/ai/runtime/tool-policy.ts'
    text = policy_path.read_text('utf-8')
    text = replace_unique(
        text,
        "  if (constraints.currencies !== undefined) {\n    if (!isStringArray(constraints.currencies)) {\n      return deny('GRANT_CONSTRAINT_INVALID', 'currencies must be an array of strings.')\n    }\n    const currencyCandidates = [args.currency, args.base_currency, args.quote_currency]\n      .filter((value): value is string => typeof value === 'string')\n    if (currencyCandidates.length === 0 || currencyCandidates.some((value) => !constraints.currencies.includes(value))) {\n      return deny('GRANT_CURRENCY_DENIED', 'This grant does not allow the requested currency.')\n    }\n  }",
        "  const allowedCurrencies = constraints.currencies\n  if (allowedCurrencies !== undefined) {\n    if (!isStringArray(allowedCurrencies)) {\n      return deny('GRANT_CONSTRAINT_INVALID', 'currencies must be an array of strings.')\n    }\n    const currencyCandidates = [args.currency, args.base_currency, args.quote_currency]\n      .filter((value): value is string => typeof value === 'string')\n    if (currencyCandidates.length === 0 || currencyCandidates.some((value) => !allowedCurrencies.includes(value))) {\n      return deny('GRANT_CURRENCY_DENIED', 'This grant does not allow the requested currency.')\n    }\n  }",
        'tool policy currency narrowing',
    )
    policy_path.write_text(text, 'utf-8')

    cr_path = root / 'src/lib/ai/runtime/change-requests-service.ts'
    text = cr_path.read_text('utf-8')
    text = replace_unique(
        text,
        "  intent: 'create' | 'update' | 'publish' | 'cancel' | 'archive'",
        "  intent: 'create' | 'create_and_attach' | 'update' | 'publish' | 'cancel' | 'archive'",
        'change request create_and_attach intent',
    )
    cr_path.write_text(text, 'utf-8')

    intents_path = root / 'src/lib/services/intents/intents-service.ts'
    text = intents_path.read_text('utf-8')
    text = replace_unique(
        text,
        "  changeRequest: { id: string; code: number; confirmationCode: string } | null",
        "  changeRequest: { id: string; code: number; confirmationCode: string | null } | null",
        'intent replay confirmation code',
    )
    intents_path.write_text(text, 'utf-8')

    test_path = root / 'src/lib/ai/runtime/agent-loop.test.ts'
    test_path.write_text(
        "import { readFileSync } from 'node:fs'\n"
        "import { describe, it, expect } from 'vitest'\n\n"
        "describe('agent-loop structured tool safety', () => {\n"
        "  it('uses native structured tools and does not export the legacy fenced parser', () => {\n"
        "    const source = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')\n"
        "    expect(source).toContain('generateNativeAgentTurn')\n"
        "    expect(source).not.toMatch(/export\\s+(?:async\\s+)?function\\s+parseToolCall/)\n"
        "  })\n"
        "})\n",
        'utf-8',
    )

def main() -> int:
    root = git_root()
    repair = root / 'repair'
    if run('git','status','--porcelain',cwd=root):
        raise ApplyError('working tree must be clean before applying the repair bundle')
    if subprocess.run(['git','merge-base','--is-ancestor',BASE_COMMIT,'HEAD'],cwd=root).returncode != 0:
        raise ApplyError(f'expected base commit {BASE_COMMIT[:8]} is not an ancestor of HEAD')
    missing=[p for p in PART_NAMES if not (repair/p).is_file()]
    if missing: raise ApplyError('missing repair bundle parts: '+', '.join(missing))

    with tempfile.TemporaryDirectory(prefix='wacrm-repair-') as td:
        tmp=pathlib.Path(td)
        b64=b''.join((repair/p).read_bytes() for p in PART_NAMES)
        try: tgz=base64.b64decode(b64, validate=True)
        except Exception as e: raise ApplyError(f'base64 bundle validation failed: {e}')
        actual=hashlib.sha256(tgz).hexdigest()
        if actual != EXPECTED_SHA256:
            raise ApplyError(f'bundle checksum mismatch: expected {EXPECTED_SHA256}, got {actual}')
        archive=tmp/'bundle.tgz'; archive.write_bytes(tgz)
        with tarfile.open(archive,'r:gz') as tf:
            for m in tf.getmembers():
                dest=(tmp/m.name).resolve()
                if not str(dest).startswith(str(tmp.resolve())+os.sep):
                    raise ApplyError(f'unsafe archive path: {m.name}')
            tf.extractall(tmp)
        bundle=tmp/'wacrm_repair_bundle'
        if not bundle.is_dir(): raise ApplyError('bundle root missing after extraction')
        if (bundle/'BASE_COMMIT').read_text().strip() != BASE_COMMIT:
            raise ApplyError('bundle BASE_COMMIT does not match installer expectation')

        staged: dict[pathlib.Path,str] = {}
        patches = {p.name: p for p in (bundle/'patches').glob('*.patch')}
        patch_order = [
            '001_tool_context_and_service_visibility.patch',
            '002_dispatch_tool_policy.patch',
            '003_admin_plane_early_gate.patch',
            '004_send_lifecycle_and_idempotency.patch',
            '005_trusted_admin_ui.patch',
            '006_router_and_coverage_safety.patch',
            '007_atomic_publish_route.patch',
            '010_routing_signals.patch',
            '008_runtime_feature_gate.patch',
            '009_worker_resume.patch',
            '011_business_handoff_integration.patch',
            '012_business_notification_idempotency.patch',
            '013_fx_customer_trade_admin_rate_boundary.patch',
            '014_customer_intent_notifications_ui.patch',
            '015_manifest_driven_tool_dispatch.patch',
        ]
        missing_patches = [name for name in patch_order if name not in patches]
        if missing_patches:
            raise ApplyError('missing semantic patches: ' + ', '.join(missing_patches))
        for patch in (patches[name] for name in patch_order):
            for rel, hunks in parse_patch(patch):
                target=root/rel
                if not target.is_file(): raise ApplyError(f'{patch.name}: target missing: {rel}')
                current=staged.get(target, target.read_text('utf-8'))
                current, hunks = adapt_patch_to_base(patch.name, rel, current, hunks)
                staged[target]=apply_semantic_patch(current,hunks,f'{patch.name}:{rel}')

        for target, text in staged.items():
            target.write_text(text,'utf-8')
        overlay=bundle/'overlay'
        for src in overlay.rglob('*'):
            if src.is_dir(): continue
            rel=src.relative_to(overlay); dst=root/rel
            dst.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(src,dst)

        post_apply_type_fixes(root)

    print('Repair bundle applied successfully.')
    print('Next: npm ci && npm run typecheck && npm test && npm run build && npm run lint')
    print('Migrations 065-067 are now present; apply them to a TEST/STAGING Supabase project first.')
    return 0

if __name__=='__main__':
    try: raise SystemExit(main())
    except ApplyError as e:
        print(f'ERROR: {e}', file=sys.stderr); raise SystemExit(1)
