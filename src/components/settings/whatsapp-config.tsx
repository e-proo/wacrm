'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { OpenWAConnections } from './openwa-connections';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';
type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
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
      console.error('fetchConfig error:', error); toast.error('Failed to load WhatsApp configuration');
    } finally { setLoading(false); }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) { loadedAccountIdRef.current = null; setLoading(false); return; }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId; void fetchConfig(accountId);
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  async function handleSave() {
    if (!canEditSettings) return toast.error('Admin access is required');
    if (!phoneNumberId.trim()) return toast.error('Phone Number ID is required');
    if (!tokenEdited || accessToken === MASKED_TOKEN || !accessToken.trim()) return toast.error('Please enter the Access Token to save Meta Cloud settings');
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number_id: phoneNumberId.trim(), waba_id: wabaId.trim() || null, access_token: accessToken.trim(), verify_token: verifyToken.trim() || null, pin: pin.trim() || null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save configuration');
      toast.success(data.registered === false ? 'Meta credentials saved; registration still needs attention.' : 'Meta Cloud configuration saved.');
      if (accountId) await fetchConfig(accountId);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to save configuration'); }
    finally { setSaving(false); }
  }

  async function handleTestConnection() {
    setTesting(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'GET', cache: 'no-store' });
      const data = await res.json(); setConnectionStatus(data.connected ? 'connected' : 'disconnected');
      if (data.connected) toast.success('Meta Cloud API connection successful'); else toast.error(data.message || 'Meta Cloud API connection failed');
    } catch { setConnectionStatus('disconnected'); toast.error('Meta Cloud API connection failed'); }
    finally { setTesting(false); }
  }

  if (loading) return <section><SettingsPanelHead title={t('title')} description={t('description')} /><div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div></section>;

  return <section className="animate-in fade-in-50 duration-200">
    <SettingsPanelHead title={t('title')} description={t('description')} />
    <Card className="mt-6">
      <CardHeader><CardTitle>Meta Cloud API</CardTitle><CardDescription>Official/default production WhatsApp provider. Existing Meta behavior remains unchanged.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm">Connection: <span className="font-medium">{connectionStatus}</span></div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label htmlFor="phone-number-id">Phone Number ID</Label><Input id="phone-number-id" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} disabled={!canEditSettings} /></div>
          <div><Label htmlFor="waba-id">WABA ID</Label><Input id="waba-id" value={wabaId} onChange={(e) => setWabaId(e.target.value)} disabled={!canEditSettings} /></div>
          <div><Label htmlFor="access-token">Access Token</Label><Input id="access-token" type="password" value={accessToken} onFocus={() => { if (!tokenEdited) { setAccessToken(''); setTokenEdited(true); } }} onChange={(e) => { setAccessToken(e.target.value); setTokenEdited(true); }} disabled={!canEditSettings} /></div>
          <div><Label htmlFor="verify-token">Verify Token</Label><Input id="verify-token" type="password" value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} disabled={!canEditSettings} /></div>
          <div><Label htmlFor="meta-pin">Two-step PIN (optional)</Label><Input id="meta-pin" value={pin} onChange={(e) => setPin(e.target.value)} disabled={!canEditSettings} /></div>
        </div>
        <div className="flex gap-2"><Button onClick={handleSave} disabled={!canEditSettings || saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Meta configuration</Button><Button variant="outline" onClick={handleTestConnection} disabled={testing}>{testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Test Meta connection</Button></div>
        {config && <p className="text-xs text-muted-foreground">Meta configuration is account-scoped. Sensitive tokens are encrypted server-side.</p>}
      </CardContent>
    </Card>
    <OpenWAConnections />
  </section>;
}
