'use client';

import { useEffect, useState } from 'react';
import { Activity, Loader2, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Metrics {
  runs: Record<string, number>;
  failedRuns: number;
  tools: Array<{ toolKey: string; calls: number; failures: number }>;
}

/**
 * Agent-operations health view: run statuses and tool-call health.
 *
 * Token spend deliberately lives in the "Usage" tab (rich charts
 * per model/mode/day) — this panel previously duplicated its
 * totals, which was removed in the 2026-09 cleanup. The failed-run
 * *list* stays in the "Runs" tab; here we show only a compact
 * failed count plus the health matrix.
 */
export function ObservabilityPanel() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai-metrics', { cache: 'no-store' });
        const json = (await res.json()) as Metrics;
        if (!res.ok) throw new Error('Could not load metrics');
        if (!cancelled) setMetrics(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load metrics');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!metrics && !error) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading metrics…
      </div>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!metrics) return null;

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5" />
        Token spend lives in the Usage tab. Full failure list lives in the Run log tab.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Run status
            {metrics.failedRuns > 0 ? (
              <Badge variant="destructive" className="ms-auto">
                {metrics.failedRuns} failed
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {Object.entries(metrics.runs).length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent runs yet.</p>
          ) : (
            Object.entries(metrics.runs).map(([status, count]) => (
              <Badge key={status} variant="outline">
                {status}: {count}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tool calls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {metrics.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tool calls yet.</p>
          ) : (
            metrics.tools.map((tool) => (
              <div
                key={tool.toolKey}
                className="flex items-center justify-between rounded border px-3 py-2 text-sm"
              >
                <code>{tool.toolKey}</code>
                <span>
                  {tool.calls} calls · {tool.failures} failures
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
