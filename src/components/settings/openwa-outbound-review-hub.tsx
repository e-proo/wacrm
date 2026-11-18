'use client'

import { useLocale } from 'next-intl'
import { CheckCircle2, ChevronDown, RefreshCw, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { OpenWAOutboundReview } from './openwa-outbound-review'

export type OutboundReviewConnection = {
  id: string
  display_name: string | null
  phone_identity: string | null
  outbound_review?: { unreviewed_count: number; reviewed_uncertain_count: number }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Already tenant-scoped by the session API. Distinct session IDs have distinct queues. */
export function summarizeOpenWAOutboundReviews(connections: readonly OutboundReviewConnection[]) {
  const affected = connections.filter((connection) =>
    safeCount(connection.outbound_review?.unreviewed_count) > 0)
  return {
    unreviewed: connections.reduce((sum, connection) =>
      sum + safeCount(connection.outbound_review?.unreviewed_count), 0),
    reviewedUncertain: connections.reduce((sum, connection) =>
      sum + safeCount(connection.outbound_review?.reviewed_uncertain_count), 0),
    affected,
    affectedCount: affected.length,
  }
}

export function OpenWAOutboundReviewHub({
  connections, expanded, selectedConnectionId, onToggle, onSelectConnection, onReviewed,
}: {
  connections: readonly OutboundReviewConnection[]
  expanded: boolean
  selectedConnectionId: string | null
  onToggle: () => void
  onSelectConnection: (id: string) => void
  onReviewed: () => void
}) {
  const ar = useLocale().startsWith('ar')
  const summary = summarizeOpenWAOutboundReviews(connections)
  const active = summary.affected.find(c => c.id === selectedConnectionId) ??
    summary.affected[0] ?? null

  return <Card className="border-border/70 shadow-sm">
    <CardHeader className="space-y-3 pb-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {summary.unreviewed > 0
              ? <ShieldAlert className="size-4 text-amber-600" aria-hidden="true" />
              : <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden="true" />}
            {ar ? 'مراجعة الإرسال' : 'Outbound review'}
          </CardTitle>
          <CardDescription>
            {ar
              ? 'ملخص واحد لجميع الاتصالات. المراجعة لا تعيد الإرسال ولا تثبت التسليم.'
              : 'One overview for all connections. Review never resends or proves delivery.'}
          </CardDescription>
        </div>
        {summary.unreviewed > 0 && <Button type="button" size="sm" variant="outline"
          aria-expanded={expanded} aria-controls="openwa-outbound-review-details"
          onClick={onToggle}>
          <ChevronDown aria-hidden="true"
            className={`me-2 size-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? (ar ? 'إخفاء التفاصيل' : 'Hide details')
            : (ar ? 'عرض التفاصيل' : 'View details')}
        </Button>}
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{ar ? 'تحتاج مراجعة' : 'Needs review'}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{summary.unreviewed}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{ar ? 'اتصالات متأثرة' : 'Affected connections'}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{summary.affectedCount}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{ar ? 'مراجعة دون تأكيد التسليم' : 'Audited, unconfirmed'}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{summary.reviewedUncertain}</p>
        </div>
      </div>
      {summary.unreviewed === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4" aria-hidden="true" />
        {ar ? 'لا توجد حاليًا رسائل تحتاج مراجعة.' : 'No messages need review right now.'}
      </p>}
      {expanded && summary.unreviewed > 0 && <div id="openwa-outbound-review-details"
        className="space-y-3 border-t pt-4">
        <div className="flex flex-wrap gap-2" role="group"
          aria-label={ar ? 'الاتصالات التي تحتاج مراجعة' : 'Connections needing review'}>
          {summary.affected.map(connection =>
            <Button key={connection.id} type="button" size="sm"
              variant={active?.id === connection.id ? 'secondary' : 'outline'}
              aria-pressed={active?.id === connection.id}
              onClick={() => onSelectConnection(connection.id)}>
              <span className="max-w-48 truncate">{connection.display_name || connection.phone_identity ||
                (ar ? 'اتصال OpenWA' : 'OpenWA connection')}</span>
              <span className="text-xs opacity-70">{connection.id.slice(0, 8)}</span>
              <Badge variant={active?.id === connection.id ? 'default' : 'outline'}>
                {safeCount(connection.outbound_review?.unreviewed_count)}
              </Badge>
            </Button>)}
        </div>
        {active && <div className="space-y-2">
          <p className="text-sm font-medium">
            {ar ? 'مراجعة الاتصال' : 'Review connection'}: {active.display_name ||
              active.phone_identity || active.id.slice(0, 8)}
          </p>
          <OpenWAOutboundReview key={active.id} connectionId={active.id}
            embedded unsettled={active.outbound_review?.unreviewed_count ?? 0}
            reviewed={active.outbound_review?.reviewed_uncertain_count ?? 0}
            onReviewed={onReviewed} />
        </div>}
        <Button size="sm" variant="ghost" type="button" onClick={onReviewed}>
          <RefreshCw className="me-2 size-4" aria-hidden="true" />
          {ar ? 'تحديث الإجمالي' : 'Refresh totals'}
        </Button>
      </div>}
    </CardContent>
  </Card>
}
