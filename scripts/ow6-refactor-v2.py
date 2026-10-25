from pathlib import Path

source = Path('scripts/ow6-refactor.py').read_text()
exec(compile(source, 'scripts/ow6-refactor.py', 'exec'))

for filename in [
    'src/app/api/whatsapp/webhook/route.ts',
    'src/app/api/whatsapp/openwa/webhook/route.ts',
    'src/lib/whatsapp/inbound-processor.ts',
]:
    path = Path(filename)
    path.write_text(path.read_text().rstrip() + '\n')
