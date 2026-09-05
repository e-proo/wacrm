import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Parity (messages.test.ts) only compares the locale files against EACH
// OTHER — a key used by a component but absent from all three still
// passes parity and detonates at runtime as MISSING_MESSAGE (this
// happened with aiConnections.cancel during Phase 05 smoke testing).
// This test walks every static `t('…')` / `tc('…')` call in the AI
// settings components and requires the resolved keypath in every
// locale catalogue.

const AI_COMPONENTS = [
  'src/components/settings/ai-config.tsx',
  'src/components/settings/ai-providers.tsx',
  'src/components/settings/model-combobox.tsx',
  'src/components/settings/ai-knowledge.tsx',
  'src/components/agents/ai-usage.tsx',
];

const LOCALES = ['en', 'ar', 'ko'] as const;

function flatKeys(locale: string): Set<string> {
  const raw = readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8');
  const out = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    out.add(path);
  };
  walk(JSON.parse(raw), '');
  return out;
}

/** Extract `var('key')` calls for every `const var = useTranslations('ns')` in a file. */
function usedKeys(source: string): string[] {
  const keys: string[] = [];
  const nsMap: Record<string, string> = {};
  const nsRe = /const (\w+) = useTranslations\('([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = nsRe.exec(source))) nsMap[m[1]] = m[2];
  for (const [variable, ns] of Object.entries(nsMap)) {
    const callRe = new RegExp(`${variable}\\(\\s*'([^']+)'`, 'g');
    let k: RegExpExecArray | null;
    while ((k = callRe.exec(source))) keys.push(`${ns}.${k[1]}`);
  }
  return keys;
}

describe('message usage coverage (AI settings components)', () => {
  const catalogues = Object.fromEntries(LOCALES.map((l) => [l, flatKeys(l)]));
  const usage = AI_COMPONENTS.flatMap((file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    return usedKeys(source).map((key) => ({ file, key }));
  });

  it.each(usage)('$file → $key exists in every locale', ({ key }) => {
    for (const locale of LOCALES) {
      expect(
        catalogues[locale].has(key),
        `${locale}.json is missing '${key}' used by a component`,
      ).toBe(true);
    }
  });
});
