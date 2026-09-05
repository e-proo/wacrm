'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Loader2, Sparkles, CheckCircle2, XCircle, AlertTriangle, Trash2, Eye, EyeOff, PlugZap, Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { ModelComboBox } from './model-combobox';
import { useModelCatalogCache } from './model-catalog-cache';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

// Select can't use an empty-string item value, so "leave unassigned"
// choices get sentinels that map to null on save.
const HANDOFF_QUEUE = '__queue__';
const MP_NONE = '__none__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

  // Map the re-index state-machine values to their i18n keys (namespace
  // Settings.aiConnections) so status text is translated, never hardcoded.
  const REINDEX_I18N_KEY: Record<string, string> = {
    legacy: 'reindexLegacy',
    pending: 'reindexPending',
    building: 'reindexBuilding',
    ready: 'reindexReady',
    failed: 'reindexFailed',
    disabled: 'reindexDisabled',
  };

  /**
   * Base UI renders the RAW selected value in <SelectValue> unless the
   * Root receives an `items` value→label map — without it the trigger
   * shows connection UUIDs and the `__none__` sentinel. Every Select in
   * this card must pass `items` so users only ever see clean names.
   */

/**
 * The ONE dynamic provider form:
 *   • AI_MULTI_PROVIDER_ENABLED off (from the server) → classic
 *     single-provider fields, exactly as before.
 *   • on → the same card becomes the unified connection picker. Picking
 *     "no connection" in either section falls back to the classic field
 *     for THAT section in place — never two parallel forms at once.
 * Model dropdowns hydrate from the shared catalog cache (fetched once
 * per credential revision); no provider traffic on render.
 */
export function AiConfig({
  onGoToProviders,
}: {
  /** Deep-switch to the Providers tab (Agents page). Hidden without it. */
  onGoToProviders?: () => void;
}) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');
  const tc = useTranslations('Settings.aiConnections');
  const tp = useTranslations('Settings.aiProviders');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // ---- multi-provider state (server-flag-gated) ----
  const [multiProvider, setMultiProvider] = useState(false);
  const [chatConnId, setChatConnId] = useState<string | null>(null);
  const [chatModelV2, setChatModelV2] = useState('');
  const [embConnId, setEmbConnId] = useState<string | null>(null);
  const [embModelV2, setEmbModelV2] = useState('');
  // 'legacy' | 'pending' | 'building' | 'ready' | 'failed' | 'disabled'
  const [reindexState, setReindexState] = useState('legacy');
  const [connectionsV2, setConnectionsV2] = useState<
    Array<{ id: string; name: string; protocol: string; status: string; updatedAt: string }>
  >([]);
  const {
    catalogs,
    ensure: ensureCatalog,
    refresh: refreshCatalog,
    busy: catalogBusyId,
  } = useModelCatalogCache(accountId);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch refetches instead of showing the previous account's
  // config. Mirrors the loadedAccountIdRef pattern in whatsapp-config.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setMultiProvider(data.multi_provider_enabled === true);
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
        setChatConnId(data.chat_connection_id ?? null);
        setChatModelV2(data.chat_model ?? '');
        setEmbConnId(data.embedding_connection_id ?? null);
        setEmbModelV2(data.embedding_model ?? '');
        setReindexState(data.embedding_reindex_state ?? 'legacy');
      } else {
        setChatConnId(null);
        setChatModelV2('');
        setEmbConnId(null);
        setEmbModelV2('');
        setReindexState('legacy');
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // Connection option list — fetched when the flag is on; the Agents
  // page remounts this card on tab switches, so additions made in the
  // Providers tab appear here without extra wiring.
  useEffect(() => {
    if (!multiProvider) return;
    let cancelled = false;
    fetch('/api/ai/connections')
      .then((r) => (r.ok ? r.json() : { connections: [] }))
      .then((d) => {
        if (cancelled) return;
        setConnectionsV2(
          (d.connections ?? []).map(
            (c: { id: string; name: string; protocol: string; status: string; updatedAt: string }) => ({
              id: c.id,
              name: c.name,
              protocol: c.protocol,
              status: c.status,
              updatedAt: c.updatedAt,
            }),
          ),
        );
      })
      .catch(() => !cancelled && setConnectionsV2([]));
    return () => {
      cancelled = true;
    };
  }, [multiProvider, configured]);

  // Row token (updated_at) is the invalidation signature for cached
  // catalogs: editing key/root/preset bumps it, so ensure() refetches —
  // from the server DB cache, still zero provider calls.
  const connToken = (id: string | null): string =>
    connectionsV2.find((c) => c.id === id)?.updatedAt ?? '';

  // value→label maps for the Base UI selects (see note above): the
  // trigger and the popup then speak human names, never UUIDs/sentinels.
  const connectionItems: Record<string, string> = {
    [MP_NONE]: tc('noneConnection'),
    ...Object.fromEntries(
      connectionsV2.map((c) => [c.id, `${c.name} · ${c.protocol}`]),
    ),
  };
  const handoffItems: Record<string, string> = {
    [HANDOFF_QUEUE]: t('handoffQueue'),
    ...Object.fromEntries(members.map((m) => [m.user_id, memberLabel(m)])),
  };

  useEffect(() => {
    if (!multiProvider) return;
    if (chatConnId) void ensureCatalog(chatConnId, connToken(chatConnId));
    if (embConnId) void ensureCatalog(embConnId, connToken(embConnId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiProvider, chatConnId, embConnId, connectionsV2, ensureCatalog]);

  // Explicit refresh ONLY — the one provider-spending path in this card.
  const doRefreshCatalog = async (connectionId: string) => {
    const { ok, error } = await refreshCatalog(connectionId, connToken(connectionId));
    if (!ok) {
      toast.error(
        error === 'AI_MODEL_DISCOVERY_UNSUPPORTED' ? tc('catalogUnavailable') : tc('verifyFailed'),
      );
    }
  };

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => {
    const body: Record<string, unknown> = {
      provider,
      model: model.trim(),
      api_key: keyPayload(),
      embeddings_api_key: embeddingsKeyPayload(),
      system_prompt: systemPrompt.trim() || null,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPerConversation,
      handoff_agent_id: handoffAgentId || null,
    };
    if (multiProvider) {
      // Always send the current pair: null = unlink connection, value
      // set = select. When linked, the server DERIVES provider/model
      // from the connection — the legacy values above become inert.
      body.chat_connection_id = chatConnId;
      body.chat_model = chatModelV2 || null;
      body.embedding_connection_id = embConnId;
      body.embedding_model = embModelV2 || null;
    }
    return body;
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const linkedChat = multiProvider && !!chatConnId;
    if (multiProvider) {
      // Connection pairs must be coherent BEFORE the server rejects them.
      if (chatConnId && !chatModelV2.trim()) {
        toast.error(tc('modelRequiredForConn'));
        return;
      }
      if (!chatConnId && chatModelV2.trim()) {
        toast.error(tc('connectionRequiredForModel'));
        return;
      }
      if (embConnId && !embModelV2.trim()) {
        toast.error(tc('modelRequiredForConn'));
        return;
      }
    }
    if (!linkedChat && !model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!linkedChat && !configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
        setChatConnId(null);
        setChatModelV2('');
        setEmbConnId(null);
        setEmbModelV2('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  // ---- reusable legacy blocks (flag-off card AND flag-on fallback) ----
  const legacyChatFields = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ai-provider">{t('provider')}</Label>
          <Select
            value={provider}
            onValueChange={(v) => handleProviderChange(v as AiProvider)}
            items={{ ...PROVIDER_LABEL }}
            disabled={disabled}
          >
            <SelectTrigger id="ai-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
              <SelectItem value="anthropic">
                {PROVIDER_LABEL.anthropic}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ai-model">{t('model')}</Label>
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ai-key">{t('apiKey')}</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="ai-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyEdited(true);
              }}
              onFocus={() => {
                if (!keyEdited && hasStoredKey) {
                  setApiKey('');
                  setKeyEdited(true);
                }
              }}
              placeholder={KEY_PLACEHOLDER[provider]}
              disabled={disabled}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={disabled || testing}
          >
            {testing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            )}
            {t('testKey')}
          </Button>
        </div>
      </div>
    </>
  );

  const legacyEmbeddingsField = (
    <div className="space-y-2">
      <Label htmlFor="ai-embeddings-key">
        {t('embeddingsKey')}{' '}
        <span className="font-normal text-muted-foreground">
          {t('optionalSemanticSearch')}
        </span>
      </Label>
      <Input
        id="ai-embeddings-key"
        type="password"
        value={embeddingsKey}
        onChange={(e) => {
          setEmbeddingsKey(e.target.value);
          setEmbeddingsKeyEdited(true);
        }}
        onFocus={() => {
          if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
            setEmbeddingsKey('');
            setEmbeddingsKeyEdited(true);
          }
        }}
        placeholder="sk-... (OpenAI)"
        disabled={disabled}
        autoComplete="off"
      />
      <p className="text-xs text-muted-foreground">
        {t('embeddingsHint', {
          sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
        })}
      </p>
    </div>
  );

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        {/* ============ THE single dynamic provider card ============ */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  {multiProvider ? (
                    <PlugZap className="h-4 w-4 text-primary" />
                  ) : (
                    <Sparkles className="h-4 w-4 text-primary" />
                  )}
                  {multiProvider ? tc('selectorsTitle') : t('providerAndKey')}
                </CardTitle>
                <CardDescription>
                  {multiProvider ? (
                    <>
                      {tc('selectorsDesc')} {t('encryptionNotice')}
                    </>
                  ) : (
                    t('encryptionNotice')
                  )}
                </CardDescription>
              </div>
              {multiProvider && onGoToProviders && (
                <Button variant="outline" size="sm" onClick={onGoToProviders} className="shrink-0">
                  <Boxes className="me-1.5 h-4 w-4" />
                  {tp('manageProviders')}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {multiProvider ? (
              <>
                {/* ---- Chat section ---- */}
                <div className="space-y-2">
                  <Label htmlFor="mp-chat-conn">{tc('chatConnectionLabel')}</Label>
                  <Select
                    value={chatConnId ?? MP_NONE}
                    onValueChange={(v) =>
                      setChatConnId(!v || v === MP_NONE ? null : v)
                    }
                    items={connectionItems}
                    disabled={disabled}
                  >
                    <SelectTrigger id="mp-chat-conn" className="w-auto min-w-56 max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MP_NONE}>{tc('noneConnection')}</SelectItem>
                      {connectionsV2.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.protocol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {chatConnId ? (
                    <ModelComboBox
                      id="mp-chat-model"
                      value={chatModelV2}
                      onChange={setChatModelV2}
                      capability="chat"
                      catalog={catalogs[chatConnId] ?? null}
                      onRefresh={() => void doRefreshCatalog(chatConnId)}
                      refreshing={catalogBusyId === chatConnId}
                      disabled={disabled}
                    />
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {tc('legacyFallbackNote')}
                      </p>
                      {legacyChatFields}
                    </>
                  )}
                </div>

                {/* ---- Embeddings section ---- */}
                <div className="space-y-2">
                  <Label htmlFor="mp-embed-conn">
                    {tc('embeddingsConnectionLabel')}
                  </Label>
                  <Select
                    value={embConnId ?? MP_NONE}
                    onValueChange={(v) =>
                      setEmbConnId(!v || v === MP_NONE ? null : v)
                    }
                    items={connectionItems}
                    disabled={disabled}
                  >
                    <SelectTrigger id="mp-embed-conn" className="w-auto min-w-56 max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MP_NONE}>{tc('noneConnection')}</SelectItem>
                      {connectionsV2.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.protocol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {embConnId ? (
                    <ModelComboBox
                      id="mp-embed-model"
                      value={embModelV2}
                      onChange={setEmbModelV2}
                      capability="embeddings"
                      catalog={catalogs[embConnId] ?? null}
                      onRefresh={() => void doRefreshCatalog(embConnId)}
                      refreshing={catalogBusyId === embConnId}
                      disabled={disabled}
                    />
                  ) : (
                    <>{legacyEmbeddingsField}</>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {tc('embeddingsDimsNote')}
                  </p>
                  <div className="flex items-center gap-2" aria-live="polite">
                    <Label className="text-xs text-muted-foreground">
                      {tc('reindexStateLabel')}
                    </Label>
                    {/* Same icon+text status surface the connections rows
                        use — never color-only signals. */}
                    <Badge
                      variant="outline"
                      className={cn(
                        'gap-1',
                        reindexState === 'ready'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                          : reindexState === 'failed'
                            ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                            : reindexState === 'building'
                              ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
                              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                      )}
                    >
                      {reindexState === 'ready' ? (
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      ) : reindexState === 'failed' ? (
                        <XCircle className="h-3 w-3" aria-hidden="true" />
                      ) : reindexState === 'building' ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      )}
                      {tc(REINDEX_I18N_KEY[reindexState] ?? REINDEX_I18N_KEY.legacy)}
                    </Badge>
                  </div>
                  {reindexState === 'pending' || reindexState === 'failed' ? (
                    <p className="text-xs text-muted-foreground">
                      {tc('reindexImpact')}
                    </p>
                  ) : null}
                  {reindexState === 'building' ? (
                    <p className="text-xs text-muted-foreground">
                      {tc('reindexInProgress')}
                    </p>
                  ) : null}
                </div>
                {chatConnId && (
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {tc('chatConnectionOverrides')}
                  </p>
                )}
              </>
            ) : (
              <>
                {legacyChatFields}
                {legacyEmbeddingsField}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>
              {t('behaviourDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                items={handoffItems}
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff" className="w-auto min-w-56 max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            (embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey) ||
            // A linked embeddings connection drives semantic indexing too.
            (multiProvider && !!embConnId && !!embModelV2)
          }
        />

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
