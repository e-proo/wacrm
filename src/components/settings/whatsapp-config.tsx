'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ArrowUpRight, CheckCircle2, ClipboardList, Cloud, LayoutDashboard, Loader2, ShieldCheck, SlidersHorizontal, Smartphone, AlertCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { OpenWAConnections } from './openwa-connections';
import { WhatsAppProviderChoicePreview } from './whatsapp-provider-choice-preview';
import { OpenWAOperationalControlCenter } from './openwa-operational-control-center';
import { getWhatsAppAdminCopy, type WhatsAppDashboardTab } from './whatsapp-admin-copy';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useWhatsAppLabels } from './whatsapp-labels';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';
type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

export function WhatsAppConfig() {
  const locale = useLocale();
  const ui = getWhatsAppAdminCopy(locale);
  const [activeTab, setActiveTab] = useState<WhatsAppDashboardTab>('overview');
  const [requestedConnectionId, setRequestedConnectionId] = useState<string | null>(null);
  const w = useWhatsAppLabels();
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const loadedAccountIdRef = useRef<string | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase.from('whatsapp_config').select('*').eq('account_id', acctId).maybeSingle();
      if (error) console.error('Failed to load config row:', error);
      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken(''); setPin(''); setTokenEdited(false);
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET', cache: 'no-store' });
          const payload = await res.json();
          setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
        } catch { setConnectionStatus('disconnected'); }
      } else {
        setConfig(null); setPhoneNumberId(''); setWabaId(''); setAccessToken(''); setVerifyToken(''); setPin(''); setTokenEdited(false); setConnectionStatus('disconnected');
      }
    } catch (error) {
      console.error('fetchConfig error:', error); toast.error(w('loadMeta'));
    } finally { setLoading(false); }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) { loadedAccountIdRef.current = null; setLoading(false); return; }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId; void fetchConfig(accountId);
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  async function handleSave() {
    if (!canEditSettings) return toast.error(w('admin'));
    if (!phoneNumberId.trim()) return toast.error(w('phoneRequired'));
    if (!tokenEdited || accessToken === MASKED_TOKEN || !accessToken.trim()) return toast.error(w('tokenRequired'));
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number_id: phoneNumberId.trim(), waba_id: wabaId.trim() || null, access_token: accessToken.trim(), verify_token: verifyToken.trim() || null, pin: pin.trim() || null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || w('saveFailed'));
      toast.success(data.registered === false ? w('savedAttention') : w('saved'));
      if (accountId) await fetchConfig(accountId);
    } catch (error) { toast.error(error instanceof Error ? error.message : w('saveFailed')); }
    finally { setSaving(false); }
  }

  async function handleTestConnection() {
    setTesting(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'GET', cache: 'no-store' });
      const data = await res.json(); setConnectionStatus(data.connected ? 'connected' : 'disconnected');
      if (data.connected) toast.success(w('testSuccess')); else toast.error(data.message || w('testFailed'));
    } catch { setConnectionStatus('disconnected'); toast.error(w('testFailed')); }
    finally { setTesting(false); }
  }

  // A role downgrade must not leave an orphaned privileged tab selected.
  useEffect(() => {
    if (!canEditSettings && !['overview', 'meta'].includes(activeTab)) {
      setActiveTab('overview');
    }
  }, [canEditSettings, activeTab]);

  function openTab(next: WhatsAppDashboardTab, connectionId?: string) {
    if (!canEditSettings && !['overview', 'meta'].includes(next)) return;
    if (connectionId) setRequestedConnectionId(connectionId);
    setActiveTab(next);
  }

  if (loading) return <section>
    <SettingsPanelHead title={ui.title} description={ui.subtitle} />
    <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin" /></div>
  </section>;

  return <section className="animate-in fade-in-50 space-y-5 duration-200">
    <SettingsPanelHead title={ui.title} description={ui.subtitle} />
    <Tabs value={activeTab} onValueChange={next => setActiveTab(next as WhatsAppDashboardTab)}
      className="w-full min-w-0 gap-4">
      <div className="max-w-full overflow-x-auto border-b pb-1" aria-label={ui.title}>
        <TabsList variant="line" className="h-12 min-w-max gap-1">
          <TabsTrigger value="overview" className="min-h-10 gap-2 px-3 sm:px-4">
            <LayoutDashboard className="size-4" aria-hidden="true" />{ui.tabs.overview}
          </TabsTrigger>
          <TabsTrigger value="meta" className="min-h-10 gap-2 px-3 sm:px-4">
            <Cloud className="size-4" aria-hidden="true" />{ui.tabs.meta}
          </TabsTrigger>
          {canEditSettings && <>
            <TabsTrigger value="sessions" className="min-h-10 gap-2 px-3 sm:px-4">
              <Smartphone className="size-4" aria-hidden="true" />{ui.tabs.sessions}
            </TabsTrigger>
            <TabsTrigger value="pilot" className="min-h-10 gap-2 px-3 sm:px-4">
              <SlidersHorizontal className="size-4" aria-hidden="true" />{ui.tabs.pilot}
            </TabsTrigger>
            <TabsTrigger value="governance" className="min-h-10 gap-2 px-3 sm:px-4">
              <ShieldCheck className="size-4" aria-hidden="true" />{ui.tabs.governance}
            </TabsTrigger>
            <TabsTrigger value="reviews" className="min-h-10 gap-2 px-3 sm:px-4">
              <ClipboardList className="size-4" aria-hidden="true" />{ui.tabs.reviews}
            </TabsTrigger>
          </>}
        </TabsList>
      </div>

      <TabsContent value="overview" className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="border-border/70 shadow-xs">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-xl bg-emerald-500/10 p-2.5 text-emerald-700 dark:text-emerald-400">
                  <Cloud className="size-5" aria-hidden="true" />
                </span>
                <Badge variant="secondary">{ui.tabs.meta}</Badge>
              </div>
              <p className="text-sm font-semibold">{ui.overview.official}</p>
              <p className="text-xs text-muted-foreground">{ui.overview.metaState}</p>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                {connectionStatus === 'connected'
                  ? <CheckCircle2 className="size-4 text-emerald-600" />
                  : <AlertCircle className="size-4 text-muted-foreground" />}
                {w(connectionStatus)}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => openTab('meta')}>
                {ui.overview.openTab}<ArrowUpRight className="ms-1.5 size-4 rtl:-scale-x-100" />
              </Button>
            </CardContent>
          </Card>
          {canEditSettings && <>
            <Card className="border-border/70 shadow-xs">
              <CardContent className="space-y-3 p-4">
                <span className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                  <Smartphone className="size-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold">{ui.overview.sessions}</p>
                <p className="min-h-10 text-xs leading-5 text-muted-foreground">{ui.overview.sessionsDesc}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => openTab('sessions')}>
                  {ui.overview.openTab}<ArrowUpRight className="ms-1.5 size-4 rtl:-scale-x-100" />
                </Button>
              </CardContent>
            </Card>
            <Card className="border-border/70 shadow-xs">
              <CardContent className="space-y-3 p-4">
                <span className="inline-flex rounded-xl bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-400">
                  <ShieldCheck className="size-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold">{ui.overview.approvals}</p>
                <p className="min-h-10 text-xs leading-5 text-muted-foreground">{ui.overview.approvalsDesc}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => openTab('governance')}>
                  {ui.overview.openTab}<ArrowUpRight className="ms-1.5 size-4 rtl:-scale-x-100" />
                </Button>
              </CardContent>
            </Card>
            <Card className="border-border/70 shadow-xs">
              <CardContent className="space-y-3 p-4">
                <span className="inline-flex rounded-xl bg-muted p-2.5 text-muted-foreground">
                  <ClipboardList className="size-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold">{ui.overview.delivery}</p>
                <p className="min-h-10 text-xs leading-5 text-muted-foreground">{ui.overview.deliveryDesc}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => openTab('reviews')}>
                  {ui.overview.openTab}<ArrowUpRight className="ms-1.5 size-4 rtl:-scale-x-100" />
                </Button>
              </CardContent>
            </Card>
          </>}
        </div>
        {canEditSettings
          ? <WhatsAppProviderChoicePreview onNavigate={next => openTab(next)} />
          : <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{ui.overview.adminOnly}</div>}
      </TabsContent>

      <TabsContent value="meta" className="space-y-4">
        <Card id="wacrm-meta-provider" className="scroll-mt-6 border-border/70 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cloud className="size-5 text-primary" aria-hidden="true" />{w('metaTitle')}
            </CardTitle>
            <CardDescription>{w('metaDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              {w('connection')}
              <Badge variant={connectionStatus === 'connected' ? 'secondary' : 'outline'}>{w(connectionStatus)}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label htmlFor="phone-number-id">{w('phone')}</Label><Input id="phone-number-id" value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} disabled={!canEditSettings} /></div>
              <div><Label htmlFor="waba-id">{w('waba')}</Label><Input id="waba-id" value={wabaId} onChange={e => setWabaId(e.target.value)} disabled={!canEditSettings} /></div>
              <div><Label htmlFor="access-token">{w('access')}</Label><Input id="access-token" type="password" autoComplete="new-password" value={accessToken} onFocus={() => { if (!tokenEdited) { setAccessToken(''); setTokenEdited(true); } }} onChange={e => { setAccessToken(e.target.value); setTokenEdited(true); }} disabled={!canEditSettings} /></div>
              <div><Label htmlFor="verify-token">{w('verify')}</Label><Input id="verify-token" type="password" autoComplete="new-password" value={verifyToken} onChange={e => setVerifyToken(e.target.value)} disabled={!canEditSettings} /></div>
              <div><Label htmlFor="meta-pin">{w('pin')}</Label><Input id="meta-pin" type="password" autoComplete="new-password" value={pin} onChange={e => setPin(e.target.value)} disabled={!canEditSettings} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={handleSave} disabled={!canEditSettings || saving}>
                {saving && <Loader2 className="me-2 size-4 animate-spin" />}{w('save')}
              </Button>
              <Button type="button" variant="outline" onClick={handleTestConnection} disabled={testing}>
                {testing && <Loader2 className="me-2 size-4 animate-spin" />}{w('test')}
              </Button>
            </div>
            {config && <p className="text-xs text-muted-foreground">{w('scope')}</p>}
          </CardContent>
        </Card>
      </TabsContent>

      {canEditSettings && <>
        <TabsContent value="sessions">
          <OpenWAConnections view="sessions" onNavigate={(next, connectionId) =>
            openTab(next === 'delivery' ? 'reviews' : next, connectionId)} />
        </TabsContent>
        <TabsContent value="pilot">
          <OpenWAConnections view="pilot" requestedConnectionId={requestedConnectionId} />
        </TabsContent>
        <TabsContent value="governance">
          <OpenWAOperationalControlCenter />
        </TabsContent>
        <TabsContent value="reviews">
          <OpenWAConnections view="delivery" requestedConnectionId={requestedConnectionId} />
        </TabsContent>
      </>}
    </Tabs>
  </section>;
}
