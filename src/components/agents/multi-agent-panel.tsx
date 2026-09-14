'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Archive,
  Bot,
  Pencil,
  ShieldCheck,
  Loader2,
  Pause,
  Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentTemplatePicker } from './agent-template-picker';
import { AgentKnowledgePanel } from './agent-knowledge-panel';
import { AgentEditor } from './agent-editor';

interface AiAgentRow {
  id: string;
  system_key: string | null;
  slug: string;
  name: string;
  description: string | null;
  purpose: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  published_revision_id: string | null;
  updated_at: string;
  latest_draft_revision_id: string | null;
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
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    agentId: string;
    revisionId: string;
  } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  // Open (or fork) the editable draft for an agent.
  async function openEditor(agent: AiAgentRow) {
    if (agent.latest_draft_revision_id) {
      setEditing({ agentId: agent.id, revisionId: agent.latest_draft_revision_id });
      return;
    }
    setBusy(`fork:${agent.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/ai-agents/${agent.id}/revisions`, { method: 'POST' });
      const json = (await res.json()) as { revisionId?: string; error?: string };
      if (!res.ok || !json.revisionId) throw new Error(json.error ?? 'fork failed');
      await load();
      setEditing({ agentId: agent.id, revisionId: json.revisionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  // Two-step archive button (arm → confirm).
  async function archiveAgent(agent: AiAgentRow) {
    if (confirmArchive !== agent.id) {
      setConfirmArchive(agent.id);
      return;
    }
    setConfirmArchive(null);
    setBusy(`archive:${agent.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/ai-agents/${agent.id}/archive`, { method: 'POST' });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'archive failed');
      }
      if (editing?.agentId === agent.id) setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

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

  async function runBackfill() {
    setBusy('backfill');
    setError(null);
    try {
      const res = await fetch('/api/admin/backfill-legacy', {
        method: 'POST',
      });
      const json = (await res.json()) as {
        skipped?: boolean;
        reason?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error ?? 'Backfill failed');
      }
      if (json.skipped && json.reason === 'no_usable_connection') {
        throw new Error(t('multiAgent.backfillNoConnection'));
      }
      if (json.skipped && json.reason === 'legacy_key_undecryptable') {
        throw new Error(t('multiAgent.backfillKeyUndecryptable'));
      }
      if (json.skipped && json.reason && json.reason !== 'already_backfilled') {
        throw new Error(
          t('multiAgent.backfillSkipped', { reason: json.reason }),
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function ingestKnowledge() {
    const agentId = agents?.find((a) => a.system_key === 'customer_service')?.id;
    setBusy('ingest');
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/ingest-knowledge-base', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(agentId ? { agentId } : {}),
      });
      // Some failures (expired session redirect, stale server without
      // this route) answer with an HTML page — surface that clearly
      // instead of a cryptic JSON parse error.
      const raw = await res.text();
      let json: { ingested?: number; assignedToRevision?: number; error?: string };
      try {
        json = JSON.parse(raw) as typeof json;
      } catch {
        const snippet = raw.slice(0, 80).replace(/\s+/g, ' ');
        throw new Error(
          `Server answered ${res.status} with non-JSON (${snippet}…). Restart the dev server so the new route is loaded; if it persists, your session may have expired — reload the page and log in again.`,
        );
      }
      if (!res.ok) {
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
      await load();
      setError(null);
      setMessage(
        `${t('multiAgent.kbIngested', { count: json.ingested ?? 0 })} — ${t('multiAgent.kbAssigned', { count: json.assignedToRevision ?? 0 })}`,
      );
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
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('multiAgent.empty')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void runBackfill()}
            disabled={busy === 'backfill'}
          >
            {busy === 'backfill' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : null}
            {t('multiAgent.runBackfill')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void ingestKnowledge()}
            disabled={busy === 'ingest'}
          >
            {busy === 'ingest' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : null}
            {t('multiAgent.ingestKb')}
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        {message ? (
          <p className="text-sm text-emerald-600">{message}</p>
        ) : null}
      </div>
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
              <div className="flex items-center gap-2 text-sm">
                <span className={agent.published_revision_id ? '' : 'text-muted-foreground'}>
                  {agent.published_revision_id
                    ? t('multiAgent.hasPublishedRevision')
                    : t('multiAgent.noPublishedRevision')}
                </span>
                {agent.latest_draft_revision_id ? (
                  <Badge variant="outline">{t('multiAgent.draftExists')}</Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {agent.status !== 'archived' ? (
                  <>
                    <Button
                      size="sm"
                      disabled={busy === `fork:${agent.id}`}
                      onClick={() => void openEditor(agent)}
                    >
                      {busy === `fork:${agent.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Pencil className="me-1.5 h-4 w-4" />
                      )}
                      {agent.latest_draft_revision_id
                        ? t('multiAgent.continueDraft')
                        : t('multiAgent.edit')}
                    </Button>
                    {agent.status === 'paused' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === agent.id}
                        onClick={() => void togglePause(agent)}
                      >
                        {busy === agent.id ? (
                          <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                        ) : null}
                        <Play className="me-1.5 h-4 w-4" />
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
                    )}
                    <Button
                      size="sm"
                      variant={confirmArchive === agent.id ? 'destructive' : 'ghost'}
                      disabled={busy === `archive:${agent.id}`}
                      onClick={() => void archiveAgent(agent)}
                    >
                      {busy === `archive:${agent.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Archive className="me-1.5 h-4 w-4" />
                      )}
                      {confirmArchive === agent.id
                        ? t('multiAgent.confirmArchive')
                        : t('multiAgent.archive')}
                    </Button>
                  </>
                ) : null}
              </div>
              <AgentKnowledgePanel
                agentId={agent.id}
                hasRevision={Boolean(agent.published_revision_id || agent.latest_draft_revision_id)}
              />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Phase 4 builder entry — create a new agent from a template. */}
      <div className="flex flex-wrap items-center gap-2">
        <AgentTemplatePicker onCreated={() => void load()} />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void ingestKnowledge()}
          disabled={busy === 'ingest'}
        >
          {busy === 'ingest' ? (
            <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
          ) : null}
          {t('multiAgent.ingestKb')}
        </Button>
      </div>
      {editing ? (() => {
        const ed = agents?.find((a) => a.id === editing.agentId);
        return (
          <AgentEditor
            key={`${editing.agentId}:${editing.revisionId}`}
            agentId={editing.agentId}
            revisionId={editing.revisionId}
            agentName={ed?.name ?? ''}
            agentDescription={ed?.description ?? null}
            allAgents={(agents ?? []).map((a) => ({ id: a.id, name: a.name }))}
            onPublished={() => {
              setEditing(null);
              void load();
            }}
            onChanged={() => void load()}
            onClose={() => setEditing(null)}
          />
        );
      })() : null}

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      {message ? (
        <p className="text-sm text-emerald-600">{message}</p>
      ) : null}
    </div>
  );
}
