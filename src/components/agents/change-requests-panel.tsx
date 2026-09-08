'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  Clock,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ChangeRequestRow {
  id: string;
  code: number;
  target_type: string;
  target_id: string | null;
  intent: string;
  proposed_payload: Record<string, unknown>;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'executed'
    | 'failed'
    | 'cancelled';
  confirmation_code: string;
  summary: string | null;
  expires_at: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  executed_at: string | null;
  execution_result: Record<string, unknown> | null;
  error_code: string | null;
}

export function ChangeRequestsPanel() {
  const t = useTranslations('Agents');
  const tCr = useTranslations('Agents.changeRequests');
  const [requests, setRequests] = useState<ChangeRequestRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCodeById, setConfirmCodeById] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<string>('pending');

  async function load() {
    setError(null);
    const url = new URL('/api/change-requests', window.location.origin);
    if (filter) url.searchParams.set('status', filter);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) {
      setRequests([]);
      return;
    }
    const json = (await res.json()) as { requests: ChangeRequestRow[] };
    setRequests(json.requests ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function act(
    id: string,
    action: 'approve' | 'reject' | 'cancel' | 'execute',
    body?: Record<string, unknown>,
  ) {
    setBusy(`${action}:${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/change-requests/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : '{}',
      });
      const json = (await res.json()) as {
        status?: string;
        error?: string;
      };
      if (!res.ok || (!json.status && action !== 'execute')) {
        throw new Error(json.error ?? `${action} failed`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  if (requests === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tCr('loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">{tCr('filter')}</label>
        <select
          className="rounded border bg-background px-2 py-1.5 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">{tCr('all')}</option>
          <option value="pending">{tCr('pending')}</option>
          <option value="approved">{tCr('approved')}</option>
          <option value="rejected">{tCr('rejected')}</option>
          <option value="expired">{tCr('expired')}</option>
          <option value="executed">{tCr('executed')}</option>
          <option value="cancelled">{tCr('cancelled')}</option>
          <option value="failed">{tCr('failed')}</option>
        </select>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tCr('empty')}</p>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  <code className="font-mono">CHG-{r.code}</code>
                  <Badge variant="outline">{r.target_type}</Badge>
                  <Badge variant="outline">{r.intent}</Badge>
                  <StatusBadge status={r.status} tCr={tCr} />
                  <span className="ms-auto font-mono text-xs text-muted-foreground">
                    <Clock className="me-1 inline h-3 w-3" />
                    {new Date(r.expires_at).toISOString()}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {r.summary ? (
                  <p className="text-sm">{r.summary}</p>
                ) : null}
                <pre className="max-h-48 overflow-auto rounded bg-muted/30 p-2 text-[10px] leading-tight">
                  {JSON.stringify(r.proposed_payload, null, 2)}
                </pre>
                {r.execution_result ? (
                  <pre className="max-h-32 overflow-auto rounded bg-emerald-500/10 p-2 text-[10px] leading-tight">
                    {JSON.stringify(r.execution_result, null, 2)}
                  </pre>
                ) : null}
                {r.error_code ? (
                  <p className="text-xs text-destructive">{r.error_code}</p>
                ) : null}

                {r.status === 'pending' ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <label className="text-sm font-medium">
                        {tCr('confirmCodeLabel')}
                      </label>
                      <Input
                        value={confirmCodeById[r.id] ?? ''}
                        onChange={(e) =>
                          setConfirmCodeById((prev) => ({
                            ...prev,
                            [r.id]: e.target.value,
                          }))
                        }
                        placeholder={tCr('confirmCodePlaceholder')}
                        inputMode="numeric"
                        className="font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        {tCr('confirmCodeHint')}
                      </p>
                    </div>
                    <Button
                      onClick={() =>
                        void act(r.id, 'approve', {
                          confirmationCode: confirmCodeById[r.id] ?? '',
                        })
                      }
                      disabled={
                        busy === `approve:${r.id}` ||
                        !confirmCodeById[r.id]
                      }
                    >
                      {busy === `approve:${r.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="me-1.5 h-4 w-4" />
                      )}
                      {tCr('approve')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void act(r.id, 'reject')}
                      disabled={busy === `reject:${r.id}`}
                    >
                      {busy === `reject:${r.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <XCircle className="me-1.5 h-4 w-4" />
                      )}
                      {tCr('reject')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void act(r.id, 'cancel')}
                      disabled={busy === `cancel:${r.id}`}
                    >
                      {busy === `cancel:${r.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Ban className="me-1.5 h-4 w-4" />
                      )}
                      {tCr('cancel')}
                    </Button>
                  </div>
                ) : null}

                {r.status === 'approved' ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Send className="h-4 w-4" />
                    <span>{tCr('approvedAwaitingExecute')}</span>
                    <Button
                      size="sm"
                      onClick={() => void act(r.id, 'execute' as never)}
                      disabled={busy === `execute:${r.id}`}
                    >
                      {busy === `execute:${r.id}` ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : null}
                      {tCr('execute')}
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

function StatusBadge({
  status,
  tCr,
}: {
  status: ChangeRequestRow['status']
  tCr: ReturnType<typeof useTranslations>
}) {
  const variant: 'default' | 'secondary' | 'destructive' =
    status === 'approved' || status === 'executed'
      ? 'default'
      : status === 'rejected' || status === 'failed' || status === 'expired' || status === 'cancelled'
        ? 'destructive'
        : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}
