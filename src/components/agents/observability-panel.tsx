'use client';

import { useEffect, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Metrics {
  usage: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
  runs: Record<string, number>;
  tools: Array<{ toolKey: string; calls: number; failures: number }>;
  recentErrors: Array<{ source: string; code: string; createdAt: string }>;
}

export function ObservabilityPanel() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai-metrics', { cache: 'no-store' });
        const json = (await res.json()) as Metrics;
        if (!res.ok) throw new Error('Could not load metrics')
        if (!cancelled) setMetrics(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load metrics');
      }
    })();
    return () => { cancelled = true };
  }, []);

  if (!metrics && !error) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading metrics…</div>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!metrics) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric title="AI calls" value={metrics.usage.calls} />
        <Metric title="Prompt tokens" value={metrics.usage.promptTokens} />
        <Metric title="Completion tokens" value={metrics.usage.completionTokens} />
        <Metric title="Total tokens" value={metrics.usage.totalTokens} />
      </div>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />Run status</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">{Object.entries(metrics.runs).map(([status, count]) => <Badge key={status} variant="outline">{status}: {count}</Badge>)}</CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Tool calls</CardTitle></CardHeader>
        <CardContent className="space-y-2">{metrics.tools.length ? metrics.tools.map((tool) => <div key={tool.toolKey} className="flex items-center justify-between rounded border px-3 py-2 text-sm"><code>{tool.toolKey}</code><span>{tool.calls} calls · {tool.failures} failures</span></div>) : <p className="text-sm text-muted-foreground">No tool calls yet.</p>}</CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Recent errors</CardTitle></CardHeader>
        <CardContent className="space-y-2">{metrics.recentErrors.length ? metrics.recentErrors.map((item, index) => <div key={`${item.createdAt}-${index}`} className="flex justify-between rounded border px-3 py-2 text-sm"><code>{item.code}</code><span className="text-muted-foreground">{new Date(item.createdAt).toISOString()}</span></div>) : <p className="text-sm text-muted-foreground">No recent errors.</p>}</CardContent>
      </Card>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: number }) {
  return <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">{title}</p><p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p></CardContent></Card>
}
