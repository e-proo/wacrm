'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check, Loader2, RefreshCw, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface KnowledgeChunk {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  preview: string;
  assigned: boolean;
  enabled: boolean;
  priority: number;
}

interface KnowledgeDraft {
  chunk_id: string;
  enabled: boolean;
  priority: number;
}

/**
 * Per-agent knowledge assignment editor: shows the account's
 * knowledge chunks with checkboxes bound to the agent's latest
 * revision, plus a one-click "inherit whole KB" sync.
 */
export function AgentKnowledgePanel({
  agentId,
  hasRevision,
}: {
  agentId: string;
  hasRevision: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<KnowledgeChunk[] | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Map<string, KnowledgeDraft>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      setChunks([]);
      return;
    }
    const json = (await res.json()) as {
      revision: { id: string } | null;
      chunks: KnowledgeChunk[];
    };
    setChunks(json.chunks ?? []);
    setRevisionId(json.revision?.id ?? null);
    setDraft(
      new Map(
        (json.chunks ?? [])
          .filter((c) => c.assigned)
          .map((c) => [c.chunk_id, { chunk_id: c.chunk_id, enabled: c.enabled, priority: c.priority }]),
      ),
    );
  }, [agentId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  function toggle(chunkId: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      const existing = next.get(chunkId);
      if (existing) {
        next.delete(chunkId);
      } else {
        next.set(chunkId, { chunk_id: chunkId, enabled: true, priority: 100 });
      }
      return next;
    });
  }

  async function save() {
    if (!revisionId) return;
    setBusy('save');
    setMessage(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionId,
          assignments: [...draft.values()],
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Save failed');
      setMessage('Saved.');
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function syncAll() {
    setBusy('sync');
    setMessage(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, {
        method: 'POST',
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Sync failed');
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  if (!hasRevision) return null;

  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? <X className="me-1.5 h-4 w-4" /> : <BookOpen className="me-1.5 h-4 w-4" />}
        Knowledge ({draft.size} assigned)
      </Button>
      {open ? (
        <div className="mt-2 space-y-2 rounded border p-3">
          {chunks === null ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : chunks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No knowledge chunks. Add documents in Setup → Knowledge first.
            </p>
          ) : (
            <>
              <div className="max-h-64 space-y-1 overflow-auto">
                {chunks.map((chunk) => {
                  const isOn = draft.has(chunk.chunk_id);
                  return (
                    <button
                      key={chunk.chunk_id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-start text-xs transition-colors ${
                        isOn ? 'border-primary bg-primary/10' : 'hover:bg-muted/40'
                      }`}
                      onClick={() => toggle(chunk.chunk_id)}
                    >
                      <span
                        className={`inline-block h-3 w-3 rounded-sm border ${
                          isOn ? 'border-primary bg-primary' : 'border-muted-foreground'
                        }`}
                      />
                      <span className="truncate">
                        #{chunk.chunk_index} · {chunk.preview}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void save()} disabled={busy === 'save' || !revisionId}>
                  {busy === 'save' ? (
                    <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="me-1.5 h-4 w-4" />
                  )}
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => void syncAll()} disabled={busy === 'sync'}>
                  {busy === 'sync' ? (
                    <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="me-1.5 h-4 w-4" />
                  )}
                  Inherit whole KB
                </Button>
              </div>
              {message ? (
                <p className="text-xs text-muted-foreground">{message}</p>
              ) : null}
              {!revisionId ? (
                <p className="text-xs text-destructive">No revision exists for this agent yet.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
