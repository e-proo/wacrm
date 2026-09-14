'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Sparkles,
  Settings2,
  BarChart3,
  Boxes,
  Users,
  ListChecks,
  ShieldCheck,
  ClipboardCheck,
  Activity,
  Brain,
  Route,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { AiProvidersPanel } from '@/components/settings/ai-providers';
import { MultiAgentPanel } from '@/components/agents/multi-agent-panel';
import { AgentRoutesPanel } from '@/components/agents/agent-routes-panel';
import { TrustedAdminsPanel } from '@/components/agents/trusted-admins-panel';
import { AgentRunsPanel } from '@/components/agents/agent-runs-panel';
import { ChangeRequestsPanel } from '@/components/agents/change-requests-panel';
import { ObservabilityPanel } from '@/components/agents/observability-panel';
import { IntentsPanel } from '@/components/agents/intents-panel';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab =
  | 'playground'
  | 'providers'
  | 'setup'
  | 'usage'
  | 'multi_agent'
  | 'routes'
  | 'trusted_admins'
  | 'runs'
  | 'change_requests'
  | 'observability'
  | 'intents';

export default function AgentsPage() {
  const { accountId, accountRole } = useAuth();
  const t = useTranslations('Agents');
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);
  const [multiProvider, setMultiProvider] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setMultiProvider(data?.multi_provider_enabled === true);
        setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canSeeMultiAgent = accountRole ? canEditSettings(accountRole) : false;

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('title')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('description')}
      </p>

      {decided && (
        <Tabs
          value={tab === 'providers' && !multiProvider ? 'setup' : tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="playground">
              <Sparkles className="me-1.5 h-4 w-4" /> {t('tabPlayground')}
            </TabsTrigger>
            {canSeeMultiAgent && (
              <TabsTrigger value="multi_agent">
                <Users className="me-1.5 h-4 w-4" /> {t('tabMultiAgent')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="routes">
                <Route className="me-1.5 h-4 w-4" /> {t('tabRoutes')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="trusted_admins">
                <ShieldCheck className="me-1.5 h-4 w-4" /> {t('tabTrustedAdmins')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="runs">
                <ListChecks className="me-1.5 h-4 w-4" /> {t('tabRuns')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="change_requests">
                <ClipboardCheck className="me-1.5 h-4 w-4" /> {t('tabChangeRequests')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="observability">
                <Activity className="me-1.5 h-4 w-4" /> {t('tabObservability')}
              </TabsTrigger>
            )}
            {canSeeMultiAgent && (
              <TabsTrigger value="intents">
                <Brain className="me-1.5 h-4 w-4" /> {t('tabIntents')}
              </TabsTrigger>
            )}
            {multiProvider && (
              <TabsTrigger value="providers">
                <Boxes className="me-1.5 h-4 w-4" /> {t('tabProviders')}
              </TabsTrigger>
            )}
            <TabsTrigger value="setup">
              <Settings2 className="me-1.5 h-4 w-4" /> {t('tabSetup')}
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="me-1.5 h-4 w-4" /> {t('tabUsage')}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          {canSeeMultiAgent && (
            <TabsContent value="multi_agent" className="mt-4">
              <MultiAgentPanel />
            </TabsContent>
          )}

          {canSeeMultiAgent && (
            <TabsContent value="routes" className="mt-4">
              <AgentRoutesPanel />
            </TabsContent>
          )}

          {canSeeMultiAgent && (
            <TabsContent value="trusted_admins" className="mt-4">
              <TrustedAdminsPanel />
            </TabsContent>
          )}

          {canSeeMultiAgent && (
            <TabsContent value="runs" className="mt-4">
              <AgentRunsPanel />
            </TabsContent>
          )}

          {multiProvider && (
            <TabsContent value="providers" className="mt-4">
              <AiProvidersPanel accountId={accountId} />
            </TabsContent>
          )}

          <TabsContent value="setup" className="mt-4">
            <AiConfig onGoToProviders={() => setTab('providers')} />
          </TabsContent>

          {canSeeMultiAgent && (
            <TabsContent value="change_requests" className="mt-4">
              <ChangeRequestsPanel />
            </TabsContent>
          )}

          {canSeeMultiAgent && (
            <TabsContent value="observability" className="mt-4">
              <ObservabilityPanel />
            </TabsContent>
          )}

          {canSeeMultiAgent && (
            <TabsContent value="intents" className="mt-4">
              <IntentsPanel />
            </TabsContent>
          )}

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
