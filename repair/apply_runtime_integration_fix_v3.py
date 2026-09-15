#!/usr/bin/env python3
"""Run v2 repair with literal regex replacement strings.

Python re.sub interprets backslash escapes in string replacements. The repair
payload contains TypeScript string literals such as '\\n\\n', which must remain
literal source text. Wrap string replacements in a callable so re.sub writes
them byte-for-byte.
"""
import re
import runpy

_original_subn = re.subn

def _literal_subn(pattern, repl, string, count=0, flags=0):
    if isinstance(repl, str):
        return _original_subn(pattern, lambda _match: repl, string, count=count, flags=flags)
    return _original_subn(pattern, repl, string, count=count, flags=flags)

re.subn = _literal_subn  # type: ignore[assignment]
runpy.run_path('repair/apply_runtime_integration_fix_v2.py', run_name='__main__')
