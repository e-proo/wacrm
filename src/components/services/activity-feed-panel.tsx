'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Activity as ActivityIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ActivityRow {
  id: number;
  target_type: string;
  target_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const TARGET_TYPES = ['fx_rate_pair', 'fx_trade_request', 'coverage_match', 'service', 'pricing_rule'] as const;

export function ActivityFeedPanel() {
  const t = useTranslations('Services');
  const tAct = useTranslations('Services.activity');
  const [events, setEvents] = useState<ActivityRow[] | null>(null);
  const [targetFilter, setTargetFilter] = useState<string>('');

  async function load() {
    const url = new URL('/api/activity-events', window.location.origin);
    if (targetFilter) url.searchParams.set('target_type', targetFilter);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) {
      setEvents([]);
      return;
    }
    const json = (await res.json()) as { events: ActivityRow[] };
    setEvents(json.events ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFilter]);

  if (events === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">{tAct('filterByType')}</label>
        <select
          className="rounded border bg-background px-2 py-1.5 text-sm"
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value)}
        >
          <option value="">{tAct('all')}</option>
          {TARGET_TYPES.map((tt) => (
            <option key={tt} value={tt}>
              {tt}
            </option>
          ))}
        </select>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tAct('empty')}</p>
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <Card key={e.id}>
              <CardContent className="py-3">
                <div className="flex items-center gap-2">
                  <ActivityIcon className="h-4 w-4 text-muted-foreground" />
                  <code className="font-mono text-xs">{e.event_type}</code>
                  <Badge variant="outline">{e.target_type}</Badge>
                  <Badge variant="secondary">{e.actor_type}</Badge>
                  <span className="ms-auto font-mono text-xs text-muted-foreground">
                    {new Date(e.created_at).toISOString()}
                  </span>
                </div>
                {Object.keys(e.payload ?? {}).length > 0 ? (
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted/30 p-2 text-[10px] leading-tight">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
