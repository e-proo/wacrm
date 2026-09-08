'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, Play, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AgentBuilderActionsProps {
  agentId: string
  revisionId: string | null
  onChanged?: () => void
}

export function AgentBuilderActions({ agentId, revisionId, onChanged }: AgentBuilderActionsProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function validate() {
    if (!revisionId) return
    setBusy('validate'); setMessage(null)
    const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}/validate`, { method: 'POST' })
    const json = (await res.json()) as { ok?: boolean; checks?: Array<{ message: string; severity: string }> }
    setMessage(json.ok ? 'Validation passed.' : `Validation failed: ${json.checks?.filter((c) => c.severity === 'error').map((c) => c.message).join(' ') ?? 'check errors'}`)
    setBusy(null)
  }

  async function evaluate() {
    if (!revisionId) return
    setBusy('evaluate'); setMessage(null)
    const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}/evaluate`, { method: 'POST' })
    const json = (await res.json()) as { evaluation?: { status: string; failed_cases: number } }
    setMessage(json.evaluation ? `Simulation: ${json.evaluation.status} (${json.evaluation.failed_cases} failed)` : 'Evaluation failed.')
    setBusy(null)
  }

  async function publish() {
    if (!revisionId) return
    setBusy('publish'); setMessage(null)
    const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}/publish`, { method: 'POST' })
    const json = (await res.json()) as { error?: string }
    setMessage(res.ok ? 'Published.' : (json.error ?? 'Publish failed.'))
    setBusy(null)
    if (res.ok) onChanged?.()
  }

  if (!revisionId) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void validate()}>
        {busy === 'validate' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="me-1.5 h-4 w-4" />}
        Validate
      </Button>
      <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void evaluate()}>
        {busy === 'evaluate' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Play className="me-1.5 h-4 w-4" />}
        Simulate
      </Button>
      <Button size="sm" disabled={Boolean(busy)} onClick={() => void publish()}>
        {busy === 'publish' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Send className="me-1.5 h-4 w-4" />}
        Publish
      </Button>
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
    </div>
  )
}
