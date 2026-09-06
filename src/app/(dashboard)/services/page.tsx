'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FolderTree, ListChecks, Banknote, Briefcase } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ServicesCategoriesPanel } from '@/components/services/categories-panel';
import { ServicesListPanel } from '@/components/services/services-list-panel';
import { ExchangeRateBooksPanel } from '@/components/services/exchange-rate-books-panel';

type Tab = 'categories' | 'services' | 'fx';

export default function ServicesPage() {
  const t = useTranslations('Services');
  const [tab, setTab] = useState<Tab>('categories');

  return (
    <div>
      <div className="flex items-center gap-2">
        <Briefcase className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('title')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-6">
        <TabsList>
          <TabsTrigger value="categories">
            <FolderTree className="me-1.5 h-4 w-4" /> {t('tabCategories')}
          </TabsTrigger>
          <TabsTrigger value="services">
            <ListChecks className="me-1.5 h-4 w-4" /> {t('tabServices')}
          </TabsTrigger>
          <TabsTrigger value="fx">
            <Banknote className="me-1.5 h-4 w-4" /> {t('tabFx')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="categories" className="mt-4">
          <ServicesCategoriesPanel />
        </TabsContent>

        <TabsContent value="services" className="mt-4">
          <ServicesListPanel />
        </TabsContent>

        <TabsContent value="fx" className="mt-4">
          <ExchangeRateBooksPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
