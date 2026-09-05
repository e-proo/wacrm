'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Ban,
  Boxes,
  CheckCircle2,
  Fish,
  Loader2,
  Pencil,
  PlugZap,
  Sparkles,
  Sun,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { ModelComboBox } from './model-combobox';
import { useModelCatalogCache, evictCatalog } from './model-catalog-cache';

/**
 * Providers section (split out of Setup, modeled on the 9Router
 * Providers UX): a grid of provider cards with live connection counts,
 * and a per-provider detail view holding the encrypted connections.
 * Setup only PICKS connections; everything managed lives here.
 *
 * Same safety discipline as before: masked key on edit (empty = keep),
 * fixed preset roots are read-only, custom roots only for deployment-
 * enabled presets, model lists hydrate from the shared catalog cache
 * (zero provider traffic on render), only Verify spends a provider call.
 */

interface SafeConnection {
  id: string;
  name: string;
  presetId: string;
  protocol: string;
  apiRoot: string;
  /** Server-derived from the stored preset id — editable root iff custom. */
  apiRootMode: 'fixed' | 'custom';
  hasKey: boolean;
  status: 'unverified' | 'verified' | 'error' | 'disabled';
  verifiedAt: string | null;
  catalogFetchedAt: string | null;
  catalogStale: boolean;
  catalogErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Preset {
  id: string;
  label: string;
  protocol: string;
  defaultApiRoot: string;
  api_root_mode: 'fixed' | 'custom';
  availability: string;
}

const PRESET_ICONS: Record<string, typeof Boxes> = {
  openai: Sparkles,
  anthropic: Boxes,
  gemini: Sun,
  deepseek: Fish,
  custom: PlugZap,
};

export function AiProvidersPanel({ accountId }: { accountId?: string | null }) {
  const t = useTranslations('Settings.aiProviders');
  const tc = useTranslations('Settings.aiConnections');

  const [connections, setConnections] = useState<SafeConnection[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openPresetId, setOpenPresetId] = useState<string | null>(null);
  const {
    catalogs,
    ensure: ensureCatalog,
    refresh: refreshCatalogWithProvider,
  } = useModelCatalogCache(accountId);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SafeConnection | null>(null);
  const [name, setName] = useState('');
  const [rootValue, setRootValue] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [savingForm, setSavingForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SafeConnection | null>(null);

  // Per-row model test state
  const [testModel, setTestModel] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string | null>>({});

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/connections');
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        if (res.status !== 404) toast.error(d?.error ?? tc('loadListFailed'));
        return;
      }
      const d = await res.json();
      setConnections(d.connections ?? []);
    } catch {
      toast.error(tc('loadListFailed'));
    } finally {
      setLoading(false);
    }
  }, [tc]);

  useEffect(() => {
    void refreshList();
    void fetch('/api/ai/provider-presets')
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((d) => setPresets(d.presets ?? []))
      .catch(() => setPresets([]));
  }, [refreshList]);

  // Hydrate every visible row's model list from the cache chain
  // (memory → localStorage → server DB cache). Zero provider traffic.
  useEffect(() => {
    for (const c of connections) {
      void ensureCatalog(c.id, c.updatedAt);
    }
  }, [connections, ensureCatalog]);

  const openPreset = presets.find((p) => p.id === openPresetId) ?? null;
  const presetConnections = openPreset
    ? connections.filter((c) => c.presetId === openPreset.id)
    : [];

  const openCreate = (preset: Preset) => {
    setEditing(null);
    setName('');
    setRootValue('');
    setKeyValue('');
    setOpenPresetId(preset.id);
    setFormOpen(true);
  };

  const openEdit = (c: SafeConnection) => {
    setEditing(c);
    setName(c.name);
    setRootValue(c.apiRootMode === 'custom' ? c.apiRoot : '');
    setKeyValue(''); // empty = keep the stored key — never prefill
    setFormOpen(true);
  };

  const handleFormSave = async () => {
    if (!name.trim()) {
      toast.error(tc('nameRequired'));
      return;
    }
    setSavingForm(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = { name: name.trim() };
        if (keyValue.trim()) body.api_key = keyValue.trim();
        if (editing.apiRootMode === 'custom' && rootValue.trim()) {
          body.api_root = rootValue.trim();
        }
        const res = await fetch(`/api/ai/connections/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(d.error ?? tc('updateFailed'));
          return;
        }
        toast.success(tc('updateSuccess'));
      } else {
        if (!openPreset) return;
        if (!keyValue.trim()) {
          toast.error(tc('keyRequired'));
          return;
        }
        const body: Record<string, unknown> = {
          name: name.trim(),
          preset_id: openPreset.id,
          api_key: keyValue.trim(),
        };
        if (openPreset.api_root_mode === 'custom') body.api_root = rootValue.trim();
        const res = await fetch('/api/ai/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (res.status === 409) {
          toast.error(tc('duplicateName'));
          return;
        }
        if (!res.ok) {
          toast.error(d.error ?? tc('createFailed'));
          return;
        }
        toast.success(tc('createSuccess'));
      }
      setFormOpen(false);
      await refreshList();
    } catch {
      toast.error(tc('updateFailed'));
    } finally {
      setSavingForm(false);
    }
  };

  const handleVerify = async (c: SafeConnection) => {
    setBusyId(c.id);
    try {
      // The ONLY provider-spending action in this panel; stores the
      // result in the server catalog + shared client cache.
      const { ok, error } = await refreshCatalogWithProvider(c.id, c.updatedAt);
      if (ok) toast.success(tc('verifySuccess'));
      else if (error === 'AI_MODEL_DISCOVERY_UNSUPPORTED') {
        toast.error(tc('catalogUnavailable'));
      } else {
        toast.error(tc('verifyFailed'));
      }
      await refreshList();
    } catch {
      toast.error(tc('verifyFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleTestModel = async (c: SafeConnection) => {
    const model = (testModel[c.id] ?? '').trim();
    if (!model) return;
    setBusyId(c.id);
    setTestResult((prev) => ({ ...prev, [c.id]: null }));
    try {
      const res = await fetch(`/api/ai/connections/${c.id}/test-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: 'chat', model }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        setTestResult((prev) => ({ ...prev, [c.id]: tc('testSuccessMsg') }));
      } else {
        const code = d.error?.code;
        const msg = code === 'AI_UNSUPPORTED_CAPABILITY'
          ? tc('testUnsupported')
          : code === 'AI_CONNECTION_TIMEOUT'
            ? tc('testTimeout')
            : tc('testFailed');
        setTestResult((prev) => ({ ...prev, [c.id]: msg }));
      }
      await refreshList();
    } catch {
      setTestResult((prev) => ({ ...prev, [c.id]: tc('testFailed') }));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (c: SafeConnection) => {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/ai/connections/${c.id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error(tc('deleteInUse'));
        return;
      }
      if (!res.ok) {
        toast.error(d.error ?? tc('deleteFailed'));
        return;
      }
      toast.success(tc('deleteSuccess'));
      if (accountId) evictCatalog(accountId, c.id);
      setDeleteTarget(null);
      await refreshList();
    } catch {
      toast.error(tc('deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  function statusBadge(c: SafeConnection) {
    const map = {
      verified: { cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', icon: CheckCircle2, label: tc('statusVerified') },
      unverified: { cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', icon: CheckCircle2, label: tc('statusUnverified') },
      error: { cls: 'bg-red-500/10 text-red-700 dark:text-red-400', icon: XCircle, label: tc('statusError') },
      disabled: { cls: 'bg-muted text-muted-foreground', icon: Ban, label: tc('statusDisabled') },
    } as const;
    const s = map[c.status] ?? map.unverified;
    const Icon = s.icon;
    return (
      <Badge variant="outline" className={s.cls} aria-label={s.label}>
        <Icon className="mr-1 h-3 w-3" aria-hidden="true" /> {s.label}
      </Badge>
    );
  }

  function presetIcon(preset: Preset) {
    const Icon = PRESET_ICONS[preset.id] ?? PlugZap;
    return (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
        <Icon className="size-5 text-primary" aria-hidden="true" />
      </span>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {tc('loading')}
      </div>
    );
  }

  // ---- detail view for one provider ----
  if (openPreset) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpenPresetId(null)}
          className="-ms-2 text-muted-foreground"
        >
          <ArrowLeft className="me-1.5 h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-3">
          {presetIcon(openPreset)}
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {openPreset.label}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('connectionCount', { count: presetConnections.length })}
            </p>
          </div>
          <Button size="sm" onClick={() => openCreate(openPreset)} className="ms-auto">
            {t('addConnection')}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('detailsTitle')}</CardTitle>
            <CardDescription className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {t('protocolLabel')}: <span className="font-mono text-xs">{openPreset.protocol}</span>
              </span>
              {openPreset.api_root_mode === 'fixed' ? (
                <span>
                  {t('endpointLabel')}: <span className="font-mono text-xs">{openPreset.defaultApiRoot}</span>
                </span>
              ) : (
                <span>{t('customEndpointNote')}</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {presetConnections.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('emptyProvider')}</p>
            )}
            {presetConnections.map((c) => {
              const catalog = catalogs[c.id] ?? null;
              return (
                <div key={c.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium">{c.name}</span>
                    {statusBadge(c)}
                    <span className="ms-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleVerify(c)}
                        disabled={busyId === c.id}
                        aria-label={`${tc('verify')} ${c.name}`}
                      >
                        {busyId === c.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(c)}
                        aria-label={`${tc('edit')} ${c.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(c)}
                        aria-label={`${tc('delete')} ${c.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={c.apiRoot}>
                    {c.apiRoot}
                  </p>

                  <div className="mt-3 grid items-end gap-2 sm:grid-cols-[1fr_auto]">
                    <div>
                      <Label htmlFor={`test-${c.id}`} className="text-xs">
                        {tc('testModelLabel')}
                      </Label>
                      <ModelComboBox
                        id={`test-${c.id}`}
                        label={tc('testModelLabel')}
                        value={testModel[c.id] ?? ''}
                        onChange={(v) =>
                          setTestModel((prev) => ({ ...prev, [c.id]: v }))
                        }
                        catalog={catalog}
                        disabled={busyId === c.id}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleTestModel(c)}
                      disabled={busyId === c.id || !(testModel[c.id] ?? '').trim()}
                    >
                      {tc('runTest')}
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                    {testResult[c.id] ?? tc('testCostHint')}
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <ConnectionFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          editing={editing}
          preset={openPreset}
          name={name}
          setName={setName}
          rootValue={rootValue}
          setRootValue={setRootValue}
          keyValue={keyValue}
          setKeyValue={setKeyValue}
          saving={savingForm}
          onSave={() => void handleFormSave()}
        />
        <DeleteDialog
          target={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteTarget && void handleDelete(deleteTarget)}
        />
      </div>
    );
  }

  // ---- provider grid ----
  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {presets.map((p) => {
          const own = connections.filter((c) => c.presetId === p.id);
          const verified = own.filter((c) => c.status === 'verified').length;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setOpenPresetId(p.id)}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-start transition-colors hover:border-primary/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {presetIcon(p)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {p.label}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {verified > 0 ? (
                    <span className="inline-block size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                  ) : own.length > 0 ? (
                    <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                  ) : null}
                  {t('connectionCount', { count: own.length })}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Create/edit/delete dialogs live in the provider detail view —
          the grid only navigates. */}
    </div>
  );
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editing,
  preset,
  name,
  setName,
  rootValue,
  setRootValue,
  keyValue,
  setKeyValue,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: SafeConnection | null;
  preset: Preset | null;
  name: string;
  setName: (v: string) => void;
  rootValue: string;
  setRootValue: (v: string) => void;
  keyValue: string;
  setKeyValue: (v: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const t = useTranslations('Settings.aiProviders');
  const tc = useTranslations('Settings.aiConnections');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? tc('editTitle') : tc('createTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing ? tc('formDesc') : t('createFor', { name: preset?.label ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="conn-name">{tc('nameLabel')}</Label>
            <Input
              id="conn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>
          {editing?.apiRootMode === 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="conn-root-custom">{tc('apiRootLabel')}</Label>
              <Input
                id="conn-root-custom"
                value={rootValue}
                onChange={(e) => setRootValue(e.target.value)}
                placeholder="https://api.example.com/v1/"
              />
              <p className="text-xs text-muted-foreground">
                {tc('rootDeploymentNotice')}
              </p>
            </div>
          )}
          {!editing && preset?.api_root_mode === 'fixed' && (
            <div className="space-y-2">
              <Label htmlFor="conn-root">{tc('apiRootLabel')}</Label>
              <Input
                id="conn-root"
                value={preset.defaultApiRoot}
                readOnly
                disabled
                aria-readonly="true"
              />
              <p className="text-xs text-muted-foreground">{tc('rootReadOnly')}</p>
            </div>
          )}
          {!editing && preset?.api_root_mode === 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="conn-root-custom-new">{tc('apiRootLabel')}</Label>
              <Input
                id="conn-root-custom-new"
                value={rootValue}
                onChange={(e) => setRootValue(e.target.value)}
                placeholder="https://api.example.com/v1/"
              />
              <p className="text-xs text-muted-foreground">
                {tc('rootDeploymentNotice')}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="conn-key">{tc('keyLabel')}</Label>
            <Input
              id="conn-key"
              type="password"
              autoComplete="off"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder={editing ? '' : 'sk-…'}
            />
            <p className="text-xs text-muted-foreground">
              {editing ? tc('keyEditHint') : tc('keyRequired')}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: SafeConnection | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tc = useTranslations('Settings.aiConnections');
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tc('deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {target ? tc('deleteConfirmDesc', { name: target.name }) : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {tc('cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {tc('deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
