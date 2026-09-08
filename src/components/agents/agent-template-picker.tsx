'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface TemplateRow {
  id: string;
  account_id: string | null;
  system_template_key: string | null;
  name: string;
  description: string | null;
  purpose: 'customer_support' | 'admin_operations' | 'custom';
  suggested_tool_keys: string[];
}

interface AgentTemplatePickerProps {
  /** Called after an agent is created so the parent can refresh. */
  onCreated: () => void;
}

/**
 * Phase 4 builder — step 1 of the wizard: pick a template, name
 * the agent, create the draft. Steps 2-8 (model, instructions,
 * knowledge, tools, routes, budgets, tests) are edited on the
 * agent detail screen before publishing.
 */
export function AgentTemplatePicker({ onCreated }: AgentTemplatePickerProps) {
  const t = useTranslations('Agents');
  const tB = useTranslations('Agents.builder');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/ai-agent-templates', { cache: 'no-store' });
      if (!res.ok || cancelled) {
        if (!cancelled) setTemplates([]);
        return;
      }
      const json = (await res.json()) as { templates: TemplateRow[] };
      if (!cancelled) setTemplates(json.templates ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function create() {
    if (!selected || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ai-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: selected, name, slug: slug || undefined }),
      });
      const json = (await res.json()) as {
        agent?: { id: string };
        error?: string;
      };
      if (!res.ok || !json.agent) {
        throw new Error(json.error ?? 'Create failed');
      }
      setOpen(false);
      setSelected(null);
      setName('');
      setSlug('');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="me-1.5 h-4 w-4" />
        {tB('newAgent')}
      </Button>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {tB('title')}
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {templates === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {tB('loadingTemplates')}
          </div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tB('noTemplates')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`rounded border p-3 text-start transition-colors ${
                  selected === tpl.id
                    ? 'border-primary bg-primary/10'
                    : 'hover:bg-muted/40'
                }`}
                onClick={() => setSelected(tpl.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{tpl.name}</span>
                  {tpl.account_id === null ? (
                    <Badge variant="secondary">{tB('system')}</Badge>
                  ) : null}
                </div>
                {tpl.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tpl.description}
                  </p>
                ) : null}
                {tpl.suggested_tool_keys.length > 0 ? (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {tpl.suggested_tool_keys.join(', ')}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">{tB('agentName')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tB('agentNamePlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{tB('agentSlug')}</label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="auto-generated"
            />
          </div>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button
          onClick={() => void create()}
          disabled={busy || !selected || !name.trim()}
        >
          {busy ? (
            <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="me-1.5 h-4 w-4" />
          )}
          {tB('createDraft')}
        </Button>
        <p className="text-xs text-muted-foreground">{tB('draftHint')}</p>
      </CardContent>
    </Card>
  );
}
