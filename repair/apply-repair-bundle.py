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
            # Reference patches are grouped semantically, not always in source-file order.
            # A unique whole-file anchor is safe even if it appears before the prior hunk.
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
        for patch in sorted((bundle/'patches').glob('*.patch')):
            for rel, hunks in parse_patch(patch):
                target=root/rel
                if not target.is_file(): raise ApplyError(f'{patch.name}: target missing: {rel}')
                current=staged.get(target, target.read_text('utf-8'))
                staged[target]=apply_semantic_patch(current,hunks,f'{patch.name}:{rel}')

        for target, text in staged.items():
            target.write_text(text,'utf-8')
        overlay=bundle/'overlay'
        for src in overlay.rglob('*'):
            if src.is_dir(): continue
            rel=src.relative_to(overlay); dst=root/rel
            dst.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(src,dst)

        checks=[bundle/'validate_syntax.js', bundle/'smoke_pure_runtime.js', bundle/'verify_business_contract.js', bundle/'verify_platform_architecture.js']
        if shutil.which('node'):
            for check in checks:
                if check.is_file():
                    p=subprocess.run(['node',str(check)],cwd=bundle,text=True)
                    if p.returncode: raise ApplyError(f'validation failed: {check.name}')
        else:
            print('WARNING: node not found; skipped bundle-local JavaScript checks', file=sys.stderr)

    print('Repair bundle applied successfully.')
    print('Next: npm ci && npm run typecheck && npm test && npm run build && npm run lint')
    print('Migrations 065-067 are now present; apply them to a TEST/STAGING Supabase project first.')
    return 0

if __name__=='__main__':
    try: raise SystemExit(main())
    except ApplyError as e:
        print(f'ERROR: {e}', file=sys.stderr); raise SystemExit(1)
