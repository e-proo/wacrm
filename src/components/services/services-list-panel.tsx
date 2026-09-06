'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ServiceRow {
  id: string;
  category_id: string;
  code: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  current_revision_id: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
}

export function ServicesListPanel() {
  const t = useTranslations('Services');
  const [services, setServices] = useState<ServiceRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [code, setCode] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const [svcRes, catRes] = await Promise.all([
      fetch('/api/services', { cache: 'no-store' }),
      fetch('/api/service-categories', { cache: 'no-store' }),
    ])
    if (!svcRes.ok || !catRes.ok) {
      setError(t('loading'))
      return
    }
    const svc = (await svcRes.json()) as { services: ServiceRow[] }
    const cat = (await catRes.json()) as { categories: CategoryRow[] }
    setServices(svc.services ?? [])
    setCategories(cat.categories ?? [])
    if (!categoryId && cat.categories && cat.categories[0]) {
      setCategoryId(cat.categories[0].id)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ categoryId, code, slug, name }),
      })
      const json = (await res.json()) as {
        service?: ServiceRow
        error?: string
      }
      if (!res.ok || !json.service) {
        throw new Error(json.error ?? 'Create failed')
      }
      setCode('')
      setSlug('')
      setName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }

  if (services === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('addService')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('category')}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('code')}</label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="COV-SANA-CASH"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('slug')}</label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('name')}</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <Button
            onClick={() => void create()}
            disabled={busy || !categoryId || !code.trim() || !slug.trim() || !name.trim()}
          >
            {busy ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="me-1.5 h-4 w-4" />
            )}
            {t('create')}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('servicesTitle')}</h3>
        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="space-y-2">
            {services.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex items-center gap-3 py-3">
                  <code className="font-mono text-xs">{s.code}</code>
                  <span className="font-medium">{s.name}</span>
                  <Badge variant="outline" className="ms-auto">
                    {s.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
