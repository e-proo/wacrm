'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Brain, Check, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface IntentRow {
  id: string;
  contact_id: string;
  direction: 'offer' | 'request';
  service_hint: string;
  summary: string | null;
  status: 'new' | 'clarifying' | 'forwarded_to_admin' | 'fulfilled' | 'rejected' | 'matched';
  attributes: Record<string, unknown>;
  matched_service_id: string | null;
  created_at: string;
}

export function IntentsPanel() {
  const [intents, setIntents] = useState<IntentRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const url = new URL('/api/customer-intents', window.location.origin);
    if (status) url.searchParams.set('status', status);
    if (query.trim()) url.searchParams.set('q', query.trim());
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) {
      setIntents([]);
      return;
    }
    const json = (await res.json()) as { intents: IntentRow[] };
    setIntents(json.intents ?? []);
  }, [status, query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatusFor(id: string, next: IntentRow['status']) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/customer-intents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Update failed');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  if (intents === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border bg-background px-2 py-1.5 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="clarifying">Clarifying</option>
          <option value="forwarded_to_admin">Forwarded to admin</option>
          <option value="fulfilled">Fulfilled</option>
          <option value="rejected">Rejected</option>
          <option value="matched">Matched</option>
        </select>
        <div className="relative">
          <Search className="pointer-events-none absolute inset-y-0 start-2 my-auto h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hint or summary…"
            className="ps-8 md:w-72"
          />
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {intents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No intents recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {intents.map((intent) => (
            <Card key={intent.id}>
              <CardContent className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Brain className="h-4 w-4 text-primary" />
                  <Badge variant="outline">
                    {intent.direction === 'offer' ? 'Offer' : 'Request'}
                  </Badge>
                  <span className="font-medium">{intent.service_hint}</span>
                  <Badge variant="secondary" className="ms-auto">
                    {intent.status}
                  </Badge>
                </div>
                {intent.summary ? (
                  <p className="text-sm text-muted-foreground">{intent.summary}</p>
                ) : null}
                {Object.keys(intent.attributes ?? {}).length > 0 ? (
                  <pre className="max-h-24 overflow-auto rounded bg-muted/30 p-2 text-[10px]">
                    {JSON.stringify(intent.attributes, null, 2)}
                  </pre>
                ) : null}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="font-mono">{intent.contact_id.slice(0, 8)}…</code>
                  <span>{new Date(intent.created_at).toISOString()}</span>
                  {intent.matched_service_id ? (
                    <code className="font-mono">
                      → {intent.matched_service_id.slice(0, 8)}…
                    </code>
                  ) : null}
                </div>
                {intent.status !== 'fulfilled' && intent.status !== 'rejected' ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === intent.id}
                      onClick={() => void setStatusFor(intent.id, 'fulfilled')}
                    >
                      <Check className="me-1.5 h-4 w-4" />
                      Fulfilled
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === intent.id}
                      onClick={() => void setStatusFor(intent.id, 'rejected')}
                    >
                      <X className="me-1.5 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
