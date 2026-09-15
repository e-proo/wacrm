#!/usr/bin/env python3
"""Run v2 repair with literal regex replacements and normalize one generated TS line."""
from pathlib import Path
import re
import runpy

_original_subn = re.subn

def _literal_subn(pattern, repl, string, count=0, flags=0):
    if isinstance(repl, str):
        return _original_subn(pattern, lambda _match: repl, string, count=count, flags=flags)
    return _original_subn(pattern, repl, string, count=count, flags=flags)

re.subn = _literal_subn  # type: ignore[assignment]
runpy.run_path('repair/apply_runtime_integration_fix_v2.py', run_name='__main__')

# The v2 payload intentionally used a double-quoted TypeScript fallback as the
# last character before a Python triple-quote delimiter. Normalize that single
# generated line to a template literal after the payload is applied.
p = Path('src/lib/ai/defaults.ts')
text = p.read_text(encoding='utf-8')
bad = '        : "if they don\'t cover the question, don\'t guess — say you\'ll check and follow up'
good = '        : `if they don\'t cover the question, don\'t guess — say you\'ll check and follow up`'
if text.count(bad) != 1:
    raise SystemExit(f'defaults.ts: expected one generated fallback line, found {text.count(bad)}')
p.write_text(text.replace(bad, good, 1), encoding='utf-8')
