'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, Loader2, RotateCw, ShieldOff, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InternationalPhoneInput } from '@/components/ui/international-phone-input';
import {
  formatLocalized,
  getAgentAdminUiText,
  localizeTrustedAdminError,
} from '@/lib/ai/ui/agent-admin-i18n';

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

interface PendingVerification {
  id: string;
  phone: string;
  displayName: string | null;
}

interface DeliveryInfo {
  accepted?: boolean;
  recipient?: string;
  messageId?: string;
  transport?: string;
  requiresOpenCustomerServiceWindow?: boolean;
}

export function TrustedAdminsPanel() {
  const t = useTranslations('Agents');
  const locale = useLocale();
  const [identities, setIdentities] = useState<TrustedIdentity[] | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneResetKey, setPhoneResetKey] = useState(0);
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingOtpFor, setPendingOtpFor] = useState<PendingVerification | null>(null);
  const [delivery, setDelivery] = useState<DeliveryInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch('/api/trusted-admins', { cache: 'no-store' });
    if (!res.ok) {
      setError(getAgentAdminUiText(locale, 'loadFailed'));
      return;
    }
    const json = (await res.json()) as { identities: TrustedIdentity[] };
    setIdentities(json.identities ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitRegistration(targetPhone: string, displayName: string | null, resend = false) {
    setError(null);
    setSuccess(null);
    setBusy(resend ? 'resend' : 'register');
    try {
      const res = await fetch('/api/trusted-admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: targetPhone, displayName }),
      });
      const json = (await res.json()) as {
        identity?: TrustedIdentity;
        otpSent?: boolean;
        delivery?: DeliveryInfo;
        error?: string;
        code?: string;
      };
      if (!res.ok || !json.identity || json.otpSent !== true) {
        throw new Error(localizeTrustedAdminError(locale, json.code, json.error));
      }
      setPendingOtpFor({ id: json.identity.id, phone: targetPhone, displayName });
      setDelivery(json.delivery ?? { accepted: true, recipient: targetPhone.replace(/^\+/, '') });
      if (!resend) {
        setPhone('');
        setName('');
        setPhoneResetKey((value) => value + 1);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : getAgentAdminUiText(locale, 'registrationFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function register() {
    if (!phone) {
      setError(getAgentAdminUiText(locale, 'invalidPhone'));
      return;
    }
    await submitRegistration(phone, name.trim() || null, false);
  }

  async function resend() {
    if (!pendingOtpFor) return;
    await submitRegistration(pendingOtpFor.phone, pendingOtpFor.displayName, true);
  }

  async function verify(id: string) {
    setError(null);
    setSuccess(null);
    if (!/^\d{6}$/.test(otp)) {
      setError(getAgentAdminUiText(locale, 'otpSixDigits'));
      return;
    }
    setBusy(id);
    try {
      const res = await fetch(`/api/trusted-admins/${id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const json = (await res.json()) as { identity?: TrustedIdentity; error?: string; code?: string };
      if (!res.ok || !json.identity) {
        throw new Error(localizeTrustedAdminError(locale, json.code, json.error));
      }
      setOtp('');
      setPendingOtpFor(null);
      setDelivery(null);
      await load();
      setSuccess(getAgentAdminUiText(locale, 'verificationSuccess'));
    } catch (e) {
      setError(e instanceof Error ? e.message : getAgentAdminUiText(locale, 'verificationFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/trusted-admins/${id}/revoke`, { method: 'POST' });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new Error(localizeTrustedAdminError(locale, json.code, json.error ?? getAgentAdminUiText(locale, 'revokeFailed')));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : getAgentAdminUiText(locale, 'revokeFailed'));
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

  const deliveryPhone = pendingOtpFor?.phone ?? (delivery?.recipient ? `+${delivery.recipient}` : '');

  return (
    <div className="space-y-6">
      {error ? (
        <div role="alert" aria-live="assertive" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      ) : null}
      {success ? (
        <div role="status" aria-live="polite" className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          {success}
        </div>
      ) : null}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('trustedAdmins.addTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('trustedAdmins.phoneLabel')}</label>
              <InternationalPhoneInput
                key={phoneResetKey}
                onChange={setPhone}
                defaultCountry="YE"
                disabled={busy === 'register'}
              />
              <p className="text-xs text-muted-foreground">{getAgentAdminUiText(locale, 'localNumberPlaceholder')}</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('trustedAdmins.nameLabel')}</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <Button type="button" onClick={() => void register()} disabled={busy === 'register' || !phone}>
            {busy === 'register' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : null}
            {t('trustedAdmins.register')}
          </Button>
        </CardContent>
      </Card>

      {pendingOtpFor ? (
        <Card className="border-primary/30">
          <CardHeader><CardTitle className="text-base">{getAgentAdminUiText(locale, 'otpAccepted')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {formatLocalized(locale, getAgentAdminUiText(locale, 'otpAcceptedHint'), { phone: deliveryPhone })}
            </p>
            {delivery?.messageId ? (
              <p className="text-xs text-muted-foreground">
                {getAgentAdminUiText(locale, 'acceptedByMeta')} · <code className="font-mono">{delivery.messageId}</code>
              </p>
            ) : null}
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-sm font-medium">{t('trustedAdmins.otpLabel')}</label>
                <Input
                  value={otp}
                  onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="000000"
                  dir="ltr"
                />
                <p className="text-xs text-muted-foreground">{getAgentAdminUiText(locale, 'otpExpiresHint')}</p>
              </div>
              <Button type="button" onClick={() => void verify(pendingOtpFor.id)} disabled={busy === pendingOtpFor.id || otp.length !== 6}>
                {busy === pendingOtpFor.id ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : null}
                {t('trustedAdmins.verify')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button type="button" size="sm" variant="outline" onClick={() => void resend()} disabled={busy === 'resend'}>
                {busy === 'resend' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <RotateCw className="me-1.5 h-4 w-4" />}
                {getAgentAdminUiText(locale, 'resendCode')}
              </Button>
              <p className="text-xs text-muted-foreground">{getAgentAdminUiText(locale, 'resendHint')}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('trustedAdmins.title')}</h3>
        {identities.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('trustedAdmins.empty')}</p>
        ) : (
          <div className="space-y-2">
            {identities.map((identity) => (
              <Card key={identity.id}>
                <CardContent className="flex flex-wrap items-center gap-3 py-3">
                  <code dir="ltr" className="font-mono text-sm">+{identity.normalized_address}</code>
                  {identity.display_name ? <span className="text-sm text-muted-foreground">{identity.display_name}</span> : null}
                  <Badge variant="outline" className="ms-auto">
                    {identity.status === 'active' ? t('trustedAdmins.statusActive') : identity.status === 'pending_verification' ? t('trustedAdmins.statusPending') : t('trustedAdmins.statusRevoked')}
                  </Badge>
                  {identity.status === 'pending_verification' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPendingOtpFor({ id: identity.id, phone: identity.normalized_address.startsWith('+') ? identity.normalized_address : `+${identity.normalized_address}`, displayName: identity.display_name });
                        setOtp('');
                        setError(null);
                        setSuccess(null);
                      }}
                    >
                      <ShieldCheck className="me-1.5 h-4 w-4" />
                      {getAgentAdminUiText(locale, 'continueVerification')}
                    </Button>
                  ) : null}
                  {identity.status !== 'revoked' ? (
                    <Button type="button" size="sm" variant="outline" disabled={busy === identity.id} onClick={() => void revoke(identity.id)}>
                      {busy === identity.id ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <ShieldOff className="me-1.5 h-4 w-4" />}
                      {t('trustedAdmins.revoke')}
                    </Button>
                  ) : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
