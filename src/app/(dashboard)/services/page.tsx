'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  FolderTree,
  ListChecks,
  Briefcase,
  Coins,
  Activity,
  Globe,
  Handshake,
  CircleDollarSign,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ServicesCategoriesPanel } from '@/components/services/categories-panel';
import { ServicesListPanel } from '@/components/services/services-list-panel';
import { PricingRulesPanel } from '@/components/services/pricing-rules-panel';
import { ActivityFeedPanel } from '@/components/services/activity-feed-panel';
import { CurrenciesPanel } from '@/components/services/currencies-panel';
import { CoveragePanel } from '@/components/services/coverage-panel';

type Tab =
  | 'categories'
  | 'services'
  | 'currencies'
  | 'rules'
  | 'coverage'
  | 'activity';

export default function ServicesPage() {
  const t = useTranslations('Services');
  const [tab, setTab] = useState<Tab>('coverage');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Briefcase className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {t('title')}
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Link
          href="/fx"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <CircleDollarSign className="h-4 w-4 text-primary" />
          FX
        </Link>
      </div>

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
