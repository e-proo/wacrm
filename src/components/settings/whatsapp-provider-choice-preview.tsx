'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { ArrowUpRight, BookOpenText, CheckCircle2, CircleDashed, Info, LockKeyhole, ShieldCheck, ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getOpenWAPolicyDraftCopy, OPENWA_POLICY_DRAFT } from '@/lib/whatsapp/transport/openwa/operational-policy-draft'

/** W07-01 preview only. No API calls, write, persisted consent or activation. */
export function WhatsAppProviderChoicePreview({
  onNavigate,
}: {
  onNavigate?: (view: 'meta' | 'sessions') => void
}) {
  const copy = getOpenWAPolicyDraftCopy(useLocale())
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-6 space-y-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5" aria-labelledby="w07-provider-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="w07-provider-title" className="font-heading text-base font-semibold tracking-tight">{copy.title}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{copy.subtitle}</p>
        </div>
        <Badge variant="outline" className="w-fit shrink-0 gap-1.5">
          <BookOpenText className="size-3.5" aria-hidden="true" />
          {copy.badge}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <article className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border bg-background p-4">
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="size-5" aria-hidden="true" />
              </span>
              <Badge variant="secondary">{copy.meta.tag}</Badge>
            </div>
            <h4 className="text-sm font-semibold">{copy.meta.name}</h4>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{copy.meta.body}</p>
          </div>
          <button type="button" onClick={() => onNavigate?.('meta')} className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            {copy.meta.link}<ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </button>
        </article>

        <article className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border bg-background p-4">
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <ShieldAlert className="size-5" aria-hidden="true" />
              </span>
              <Badge variant="outline">{copy.openwa.tag}</Badge>
            </div>
            <h4 className="text-sm font-semibold">{copy.openwa.name}</h4>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{copy.openwa.body}</p>
          </div>
          <button type="button" onClick={() => onNavigate?.('sessions')} className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            {copy.openwa.link}<ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </button>
        </article>
      </div>

      <div role="note" className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm leading-6">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <p>{copy.notice}</p>
      </div>

      <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h4 className="text-sm font-semibold">{copy.stepsTitle}</h4>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            <BookOpenText className="size-4" aria-hidden="true" />
            {copy.reviewButton}
          </Button>
        </div>
        <ol className="grid gap-3 lg:grid-cols-3">
          {copy.steps.map((step, index) => (
            <li key={step.name} className="flex gap-3 rounded-lg bg-background p-3 ring-1 ring-border/70">
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                {index === 0
                  ? <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
                  : <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{step.state}</p>
                <p className="mt-1 text-sm font-medium">{step.name}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <section className="space-y-2" aria-labelledby="w07-help-title">
        <h4 id="w07-help-title" className="text-sm font-semibold">{copy.helpTitle}</h4>
        <p className="text-xs leading-5 text-muted-foreground">{copy.helpSubtitle}</p>
        <div className="divide-y rounded-xl border px-4">
          {copy.faq.map((item) => (
            <details key={item.question} className="py-3">
              <summary className="cursor-pointer rounded-sm text-sm font-medium leading-6 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
                {item.question}
              </summary>
              <p className="mt-2 pb-1 text-sm leading-6 text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="size-4" aria-hidden="true" />{copy.reviewTitle}
            </DialogTitle>
            <DialogDescription>{copy.reviewSubtitle}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
              {OPENWA_POLICY_DRAFT.version} · {copy.notice}
            </p>
            <h4 className="text-sm font-semibold">{copy.riskTitle}</h4>
            <ul className="space-y-3">
              {copy.risks.map((risk) => (
                <li key={risk.title} className="rounded-lg border p-3">
                  <p className="text-sm font-semibold">{risk.title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{risk.description}</p>
                </li>
              ))}
            </ul>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-sm font-semibold">{copy.consentBoundary.title}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{copy.consentBoundary.body}</p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{copy.close}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
