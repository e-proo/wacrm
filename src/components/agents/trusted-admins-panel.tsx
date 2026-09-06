'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldOff, ShieldCheck, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface TrustedIdentity {
  id: string;
  channel: 'whatsapp';
  normalized_address: string;
  display_name: string | null;
  status: 'pending_verification' | 'active' | 'revoked';
  verified_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function TrustedAdminsPanel() {
  const t = useTranslations('Agents');
  const [identities, setIdentities] = useState<TrustedIdentity[] | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingOtpFor, setPendingOtpFor] = useState<{
    id: string;
    otp: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch('/api/trusted-admins', { cache: 'no-store' });
    if (!res.ok) {
      setError(t('trustedAdmins.loading'));
      return;
    }
    const json = (await res.json()) as { identities: TrustedIdentity[] };
    setIdentities(json.identities ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function register() {
    setError(null);
    setBusy('register');
    try {
      const res = await fetch('/api/trusted-admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, displayName: name || null }),
      });
      const json = (await res.json()) as {
        identity?: TrustedIdentity;
        otp?: string;
        error?: string;
      };
      if (!res.ok || !json.identity || !json.otp) {
        throw new Error(json.error ?? 'Registration failed');
      }
      setPendingOtpFor({ id: json.identity.id, otp: json.otp });
      setPhone('');
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function verify(id: string) {
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/trusted-admins/${id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const json = (await res.json()) as {
        identity?: TrustedIdentity;
        error?: string;
      };
      if (!res.ok || !json.identity) {
        throw new Error(json.error ?? 'Verification failed');
      }
      setOtp('');
      setPendingOtpFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/trusted-admins/${id}/revoke`, {
        method: 'POST',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Revoke failed');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  if (identities === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('trustedAdmins.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('trustedAdmins.addTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {t('trustedAdmins.phoneLabel')}
              </label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+967777123456"
              />
              <p className="text-xs text-muted-foreground">
                {t('trustedAdmins.phoneHint')}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {t('trustedAdmins.nameLabel')}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <Button
            onClick={() => void register()}
            disabled={busy === 'register' || !phone.trim()}
          >
            {busy === 'register' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : null}
            {t('trustedAdmins.register')}
          </Button>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>

      {pendingOtpFor ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('trustedAdmins.showOtpTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('trustedAdmins.showOtpDescription')}
            </p>
            <div className="flex items-center gap-2">
              <code className="rounded border bg-muted px-3 py-2 font-mono text-lg tracking-widest">
                {pendingOtpFor.otp}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(pendingOtpFor.otp);
                }}
              >
                <Copy className="me-1.5 h-4 w-4" />
                {t('trustedAdmins.copyOtp')}
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-sm font-medium">
                  {t('trustedAdmins.otpLabel')}
                </label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <Button
                onClick={() => void verify(pendingOtpFor.id)}
                disabled={busy === pendingOtpFor.id || !otp.trim()}
              >
                {t('trustedAdmins.verify')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('trustedAdmins.title')}</h3>
        {identities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('trustedAdmins.empty')}
          </p>
        ) : (
          <div className="space-y-2">
            {identities.map((id) => (
              <Card key={id.id}>
                <CardContent className="flex items-center gap-3 py-3">
                  <code className="font-mono text-sm">
                    +{id.normalized_address}
                  </code>
                  {id.display_name ? (
                    <span className="text-sm text-muted-foreground">
                      {id.display_name}
                    </span>
                  ) : null}
                  <Badge variant="outline" className="ms-auto">
                    {id.status === 'active'
                      ? t('trustedAdmins.statusActive')
                      : id.status === 'pending_verification'
                        ? t('trustedAdmins.statusPending')
                        : t('trustedAdmins.statusRevoked')}
                  </Badge>
                  {id.status !== 'revoked' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === id.id}
                      onClick={() => void revoke(id.id)}
                    >
                      {busy === id.id ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldOff className="me-1.5 h-4 w-4" />
                      )}
                      {t('trustedAdmins.revoke')}
                    </Button>
                  ) : (
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
