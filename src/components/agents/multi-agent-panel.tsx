'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ShieldCheck, Loader2, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface AiAgentRow {
  id: string;
  system_key: string | null;
  slug: string;
  name: string;
  purpose: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  published_revision_id: string | null;
  updated_at: string;
}

interface AiAgentRevision {
  id: string;
  agent_id: string;
  revision_number: number;
  status: string;
  model: string;
  published_at: string | null;
}

export function MultiAgentPanel() {
  const t = useTranslations('Agents');
  const [agents, setAgents] = useState<AiAgentRow[] | null>(null);
  const [revisions, setRevisions] = useState<Record<string, AiAgentRevision | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch('/api/ai-agents', { cache: 'no-store' });
    if (!res.ok) {
      setError(t('multiAgent.loading'));
      return;
    }
    const json = (await res.json()) as { agents: AiAgentRow[] };
    setAgents(json.agents ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function togglePause(agent: AiAgentRow) {
    const action = agent.status === 'paused' ? 'resume' : 'pause';
    setBusy(agent.id);
    setError(null);
    try {
      const res = await fetch(`/api/ai-agents/${agent.id}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Request failed');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  // Hydrate revisions for each agent (best-effort, lightweight: the
  // list endpoint already returns enough; published_revision_id is
  // all we need to surface "Revision N · model" if we later expose
  // a join. For Phase 1 we render the agent row alone.)
  useEffect(() => {
    if (!agents) return;
    const next: Record<string, AiAgentRevision | null> = {};
    for (const a of agents) {
      next[a.id] = revisions[a.id] ?? null;
    }
    setRevisions(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  if (agents === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('multiAgent.loading')}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('multiAgent.empty')}</p>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {agent.purpose === 'admin_operations' ? (
                  <ShieldCheck className="h-5 w-5 text-primary" />
                ) : (
                  <Bot className="h-5 w-5 text-primary" />
                )}
                <span>
                  {agent.system_key === 'admin_operations'
                    ? t('multiAgent.adminOperations')
                    : agent.system_key === 'customer_service'
                      ? t('multiAgent.customerService')
                      : agent.name}
                </span>
                <Badge variant="outline" className="ms-auto">
                  {agent.system_key
                    ? agent.system_key === 'admin_operations'
                      ? t('multiAgent.systemKeyAdminOperations')
                      : t('multiAgent.systemKeyCustomerService')
                    : agent.slug}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">{t('multiAgent.status')}: </span>
                {agent.status === 'active'
                  ? t('multiAgent.statusActive')
                  : agent.status === 'paused'
                    ? t('multiAgent.statusPaused')
                    : agent.status === 'archived'
                      ? t('multiAgent.statusArchived')
                      : t('multiAgent.statusDraft')}
              </div>
              <div className="text-sm">
                {agent.published_revision_id
                  ? t('multiAgent.publishedRevision', {
                      number: '—',
                      model: '—',
                    })
                  : t('multiAgent.noPublishedRevision')}
              </div>
              <div className="flex gap-2">
                {agent.status !== 'archived' &&
                  (agent.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === agent.id}
                      onClick={() => void togglePause(agent)}
                    >
                      {busy === agent.id ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="me-1.5 h-4 w-4" />
                      )}
                      {t('multiAgent.resume')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === agent.id}
                      onClick={() => void togglePause(agent)}
                    >
                      {busy === agent.id ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Pause className="me-1.5 h-4 w-4" />
                      )}
                      {t('multiAgent.pause')}
                    </Button>
                  ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
