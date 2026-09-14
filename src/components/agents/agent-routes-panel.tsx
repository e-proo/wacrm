'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';

// ============================================================
// Agent routing manager — the rules that decide WHICH agent
// answers an inbound message (ai_agent_routes, migration 046).
//
// Kind order at runtime: admin plane first, then rules by
// priority desc, then the single active default per channel.
// ============================================================

interface RouteConditions {
  inbox_id?: string;
  tags?: string[];
  language?: string;
  business_hours?: {
    start: string;
    end: string;
    tz: string;
    weekdays: number[];
  };
}

interface RouteRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  name: string;
  channel: string;
  route_kind: 'admin' | 'rule' | 'default';
  priority: number;
  is_active: boolean;
  conditions: RouteConditions;
  stop_processing: boolean;
}

interface AgentOption {
  id: string;
  name: string;
}

interface DraftForm {
  id: string | null; // null → create
  name: string;
  agentId: string;
  routeKind: string;
  priority: string;
  isActive: boolean;
  stopProcessing: boolean;
  tags: string;
  language: string;
  inbox: string;
  bhStart: string;
  bhEnd: string;
  bhTz: string;
  bhDays: number[];
  useBusinessHours: boolean;
}

function emptyDraft(): DraftForm {
  return {
    id: null,
    name: '',
    agentId: '',
    routeKind: 'rule',
    priority: '100',
    isActive: true,
    stopProcessing: true,
    tags: '',
    language: '',
    inbox: '',
    bhStart: '09:00',
    bhEnd: '17:00',
    bhTz: 'Asia/Aden',
    bhDays: [0, 1, 2, 3, 4],
    useBusinessHours: false,
  };
}

export function AgentRoutesPanel() {
  const t = useTranslations('Agents.routes');
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/ai-routes', { cache: 'no-store' });
    if (!res.ok) {
      setError(`${t('loadFailed')} (${res.status})`);
      setRoutes([]);
      return;
    }
    const json = (await res.json()) as {
      routes: RouteRow[];
      agents: Array<{ id: string; name: string; status: string }>;
    };
    setRoutes(json.routes ?? []);
    setAgents((json.agents ?? []).map((a) => ({ id: a.id, name: a.name })));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(row: RouteRow) {
    const c = row.conditions ?? {};
    setDraft({
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      routeKind: row.route_kind,
      priority: String(row.priority),
      isActive: row.is_active,
      stopProcessing: row.stop_processing,
      tags: (c.tags ?? []).join(', '),
      language: c.language ?? '',
      inbox: c.inbox_id ?? '',
      bhStart: c.business_hours?.start ?? '09:00',
      bhEnd: c.business_hours?.end ?? '17:00',
      bhTz: c.business_hours?.tz ?? 'Asia/Aden',
      bhDays: c.business_hours?.weekdays ?? [0, 1, 2, 3, 4],
      useBusinessHours: Boolean(c.business_hours),
    });
  }

  async function save() {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      const conditions: RouteConditions = {};
      if (draft.inbox.trim()) conditions.inbox_id = draft.inbox.trim();
      const tagList = draft.tags.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
      if (tagList.length > 0) conditions.tags = tagList;
      if (draft.language.trim()) conditions.language = draft.language.trim().toLowerCase();
      if (draft.useBusinessHours) {
        conditions.business_hours = {
          start: draft.bhStart,
          end: draft.bhEnd,
          tz: draft.bhTz,
          weekdays: draft.bhDays,
        };
      }
      const body = {
        name: draft.name.trim(),
        agentId: draft.agentId,
        routeKind: draft.routeKind,
        priority: Number(draft.priority || 100),
        isActive: draft.isActive,
        stopProcessing: draft.stopProcessing,
        conditions,
      };
      const url = draft.id
        ? `/api/ai-routes/${draft.id}`
        : '/api/ai-routes';
      const res = await fetch(url, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'save failed');
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(`del:${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/ai-routes/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'delete failed');
      setRoutes((routes ?? []).filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  const kindLabel = (k: string): string =>
    k === 'admin' ? t('kindAdmin') : k === 'default' ? t('kindDefault') : t('kindRule');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div>
          <h2 className="text-base font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Button size="sm" className="ms-auto" onClick={() => setDraft(emptyDraft())}>
          <Plus className="me-1.5 h-4 w-4" /> {t('newRoute')}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {draft ? (
        <Card className="border-primary/40">
          <CardHeader className="flex flex-row items-center">
            <CardTitle className="text-base">{draft.id ? t('editRoute') : t('newRoute')}</CardTitle>
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setDraft(null)}>
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label={t('fieldName')}>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label={t('fieldAgent')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
                  <option value="">—</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label={t('fieldKind')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={draft.routeKind} onChange={(e) => setDraft({ ...draft, routeKind: e.target.value })}>
                  <option value="rule">{t('kindRule')}</option>
                  <option value="default">{t('kindDefault')}</option>
                  <option value="admin">{t('kindAdmin')}</option>
                </select>
              </Field>
              <Field label={t('fieldPriority')}>
                <Input inputMode="numeric" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
              </Field>
              <Field label={t('fieldTags')} span>
                <Input
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder={t('fieldTagsHint')}
                />
              </Field>
              <Field label={t('fieldLanguage')}>
                <Input value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} placeholder="ar" />
              </Field>
              <Field label={t('fieldInbox')}>
                <Input value={draft.inbox} onChange={(e) => setDraft({ ...draft, inbox: e.target.value })} placeholder="uuid" />
              </Field>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.isActive} onCheckedChange={(v) => setDraft({ ...draft, isActive: v === true })} />
                  {t('fieldActive')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.stopProcessing} onCheckedChange={(v) => setDraft({ ...draft, stopProcessing: v === true })} />
                  {t('fieldStop')}
                </label>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="bh-toggle"
                  checked={draft.useBusinessHours}
                  onCheckedChange={(v) => setDraft({ ...draft, useBusinessHours: v === true })}
                />
                <label htmlFor="bh-toggle">{t('fieldBusinessHours')}</label>
              </div>
            </div>
            {draft.useBusinessHours ? (
              <div className="grid grid-cols-1 gap-3 rounded border p-3 md:grid-cols-4">
                <Field label="start"><Input value={draft.bhStart} onChange={(e) => setDraft({ ...draft, bhStart: e.target.value })} /></Field>
                <Field label="end"><Input value={draft.bhEnd} onChange={(e) => setDraft({ ...draft, bhEnd: e.target.value })} /></Field>
                <Field label="tz"><Input value={draft.bhTz} onChange={(e) => setDraft({ ...draft, bhTz: e.target.value })} /></Field>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('fieldWeekdays')}</label>
                  <div className="flex flex-wrap gap-1">
                    {([0, 1, 2, 3, 4, 5, 6] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={`rounded border px-2 py-1 text-xs ${draft.bhDays.includes(d) ? 'border-primary bg-primary/10' : 'opacity-60'}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            bhDays: draft.bhDays.includes(d)
                              ? draft.bhDays.filter((x) => x !== d)
                              : [...draft.bhDays, d].sort(),
                          })
                        }
                      >
                        {t(`day${d}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            <Button size="sm" disabled={busy !== null || !draft.name.trim() || !draft.agentId} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : <Save className="me-1 h-3.5 w-3.5" />}
              {t('save')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {routes === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
        </div>
      ) : routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="space-y-2">
          {routes.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
                <Badge variant={r.route_kind === 'default' ? 'default' : 'secondary'}>
                  {kindLabel(r.route_kind)}
                </Badge>
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">→ {r.agent_name ?? r.agent_id}</span>
                <span className="font-mono text-xs text-muted-foreground">P{r.priority}</span>
                {r.stop_processing ? <span className="text-xs text-muted-foreground">⏹</span> : null}
                {(r.conditions?.tags?.length ?? 0) > 0 ? (
                  <span className="text-xs text-muted-foreground">#{(r.conditions?.tags ?? []).join(' #')}</span>
                ) : null}
                {r.conditions?.language ? <span className="text-xs text-muted-foreground">[{r.conditions.language}]</span> : null}
                {r.conditions?.business_hours ? <span className="text-xs text-muted-foreground">🕐 {r.conditions.business_hours.start}-{r.conditions.business_hours.end}</span> : null}
                <span className={r.is_active ? 'text-xs text-emerald-600' : 'text-xs text-muted-foreground'}>
                  {r.is_active ? t('active') : t('inactive')}
                </span>
                <div className="ms-auto flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => startEdit(r)}>
                    {t('edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busy === `del:${r.id}`}
                    onClick={() => void remove(r.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: boolean }) {
  return (
    <div className={`space-y-1 ${span ? 'md:col-span-2' : ''}`}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
