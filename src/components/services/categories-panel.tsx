'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ServiceCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'archived';
}

export function ServicesCategoriesPanel() {
  const t = useTranslations('Services');
  const [categories, setCategories] = useState<ServiceCategory[] | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch('/api/service-categories', { cache: 'no-store' });
    if (!res.ok) {
      setError(t('loading'));
      return;
    }
    const json = (await res.json()) as { categories: ServiceCategory[] };
    setCategories(json.categories ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/service-categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, name }),
      });
      const json = (await res.json()) as {
        category?: ServiceCategory;
        error?: string;
      };
      if (!res.ok || !json.category) {
        throw new Error(json.error ?? 'Create failed');
      }
      setSlug('');
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  if (categories === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('addCategory')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
            disabled={busy || !slug.trim() || !name.trim()}
          >
            {busy ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="me-1.5 h-4 w-4" />
            )}
            {t('create')}
          </Button>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('categoriesTitle')}</h3>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="space-y-2">
            {categories.map((c) => (
              <Card key={c.id}>
                <CardContent className="flex items-center gap-3 py-3">
                  <code className="font-mono text-xs text-muted-foreground">
                    {c.slug}
                  </code>
                  <span className="font-medium">{c.name}</span>
                  {c.description ? (
                    <span className="text-sm text-muted-foreground">
                      {c.description}
                    </span>
                  ) : null}
                  <Badge variant="outline" className="ms-auto">
                    {c.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
