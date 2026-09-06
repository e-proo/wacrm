'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

interface RunRow {
  id: string;
  conversation_id: string;
  ai_agent_id: string;
  plane: 'admin' | 'customer';
  route_reason: string | null;
  status: string;
  error_code: string | null;
  created_at: string;
}

export function AgentRunsPanel() {
  const t = useTranslations('Agents');
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [conversationFilter, setConversationFilter] = useState('');

  async function load() {
    const url = new URL('/api/agent-runs', window.location.origin);
    if (conversationFilter.trim()) {
      url.searchParams.set('conversation_id', conversationFilter.trim());
    }
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) {
      setRuns([]);
      return;
    }
    const json = (await res.json()) as { runs: RunRow[] };
    setRuns(json.runs ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationFilter]);

  if (runs === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('runs.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder={t('runs.filterConversation')}
          value={conversationFilter}
          onChange={(e) => setConversationFilter(e.target.value)}
          className="max-w-md"
        />
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('runs.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1">{t('runs.created')}</th>
                <th className="px-2 py-1">{t('runs.plane')}</th>
                <th className="px-2 py-1">{t('runs.status')}</th>
                <th className="px-2 py-1">{t('runs.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-2 py-2 font-mono text-xs">
                    {new Date(r.created_at).toISOString()}
                  </td>
                  <td className="px-2 py-2">
                    <Badge variant="outline">
                      {r.plane === 'admin'
                        ? t('runs.planeAdmin')
                        : t('runs.planeCustomer')}
                    </Badge>
                  </td>
                  <td className="px-2 py-2">{r.status}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {r.route_reason ?? r.error_code ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
