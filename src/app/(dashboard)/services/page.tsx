'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  FolderTree,
  ListChecks,
  Banknote,
  Briefcase,
  Coins,
  Activity,
  Globe,
  Handshake,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ServicesCategoriesPanel } from '@/components/services/categories-panel';
import { ServicesListPanel } from '@/components/services/services-list-panel';
import { ExchangeRateBooksPanel } from '@/components/services/exchange-rate-books-panel';
import { PricingRulesPanel } from '@/components/services/pricing-rules-panel';
import { ActivityFeedPanel } from '@/components/services/activity-feed-panel';
import { CurrenciesPanel } from '@/components/services/currencies-panel';
import { CoveragePanel } from '@/components/services/coverage-panel';

type Tab =
  | 'categories'
  | 'services'
  | 'currencies'
  | 'fx'
  | 'rules'
  | 'coverage'
  | 'activity';

export default function ServicesPage() {
  const t = useTranslations('Services');
  const [tab, setTab] = useState<Tab>('coverage');

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
          <TabsTrigger value="currencies">
            <Globe className="me-1.5 h-4 w-4" /> {t('tabCurrencies')}
          </TabsTrigger>
          <TabsTrigger value="rules">
            <Coins className="me-1.5 h-4 w-4" /> {t('tabRules')}
          </TabsTrigger>
          <TabsTrigger value="fx">
            <Banknote className="me-1.5 h-4 w-4" /> {t('tabFx')}
          </TabsTrigger>
          <TabsTrigger value="coverage">
            <Handshake className="me-1.5 h-4 w-4" /> {t('tabCoverage')}
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Activity className="me-1.5 h-4 w-4" /> {t('tabActivity')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="categories" className="mt-4">
          <ServicesCategoriesPanel />
        </TabsContent>

        <TabsContent value="services" className="mt-4">
          <ServicesListPanel />
        </TabsContent>

        <TabsContent value="currencies" className="mt-4">
          <CurrenciesPanel />
        </TabsContent>

        <TabsContent value="rules" className="mt-4">
          <PricingRulesPanel />
        </TabsContent>

        <TabsContent value="fx" className="mt-4">
          <ExchangeRateBooksPanel />
        </TabsContent>

        <TabsContent value="coverage" className="mt-4">
          <CoveragePanel />
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityFeedPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
