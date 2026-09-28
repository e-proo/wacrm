'use client'

import { useEffect, useState } from 'react'
import { FlaskConical, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type OperationalMode = 'reactive' | 'outbound' | 'both'
type ApprovalMode = 'none' | 'task' | 'batch'

interface TaskTypeOption {
  key: string
  version: number
  title: string
  description: string
  maxTargets: number
}

interface OutreachPolicy {
  taskTypes: Array<{ key: string; version: number }>
  targetScope: { kind: string; selector: string; values: string[] }
  limits: {
    maxTargets: number
    maxAttempts: number
    followupCount: number
    cooldownMinutes: number
    workingHours: string
    dailyBudget: number
    tokenBudget: number
    messageBudget: number
  }
  approvalMode: ApprovalMode
}

const DEFAULT_POLICY: OutreachPolicy = {
  taskTypes: [],
  targetScope: { kind: 'predefined_filter', selector: '', values: [] },
  limits: {
    maxTargets: 100,
    maxAttempts: 3,
    followupCount: 1,
    cooldownMinutes: 1440,
    workingHours: '09:00-17:00',
    dailyBudget: 0,
    tokenBudget: 0,
    messageBudget: 0,
  },
  approvalMode: 'task',
}

function normalizePolicy(value: unknown): OutreachPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_POLICY
  const raw = value as Partial<OutreachPolicy>
  return {
    taskTypes: Array.isArray(raw.taskTypes) ? raw.taskTypes : [],
    targetScope: { ...DEFAULT_POLICY.targetScope, ...(raw.targetScope ?? {}) },
    limits: { ...DEFAULT_POLICY.limits, ...(raw.limits ?? {}) },
    approvalMode: raw.approvalMode ?? DEFAULT_POLICY.approvalMode,
  }
}

export function AgentOutreachBuilder(props: {
  agentId: string
  revisionId: string
  onChanged: () => void
}) {
  const [mode, setMode] = useState<OperationalMode>('reactive')
  const [policy, setPolicy] = useState<OutreachPolicy>(DEFAULT_POLICY)
  const [taskTypes, setTaskTypes] = useState<TaskTypeOption[]>([])
  const [scopeKinds, setScopeKinds] = useState<string[]>([])
  const [busy, setBusy] = useState<'load' | 'save' | 'dry' | null>('load')
  const [note, setNote] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    let cancelled = false
    setBusy('load')
    Promise.all([
      fetch(`/api/ai-agents/${props.agentId}/revisions/${props.revisionId}`, { cache: 'no-store' }),
      fetch('/api/agent-task-types', { cache: 'no-store' }),
    ])
      .then(async ([revisionRes, catalogRes]) => {
        if (!revisionRes.ok || !catalogRes.ok) throw new Error('Failed to load outbound Builder settings.')
        const revisionJson = await revisionRes.json() as {
          revision: { operational_mode?: OperationalMode; outreach_policy?: unknown }
        }
        const catalogJson = await catalogRes.json() as {
          taskTypes?: TaskTypeOption[]
          targetScopeKinds?: string[]
        }
        if (cancelled) return
        setMode(revisionJson.revision.operational_mode ?? 'reactive')
        setPolicy(normalizePolicy(revisionJson.revision.outreach_policy))
        setTaskTypes(catalogJson.taskTypes ?? [])
        setScopeKinds(catalogJson.targetScopeKinds ?? [])
      })
      .catch((error) => {
        if (!cancelled) setNote(error instanceof Error ? error.message : 'Load failed.')
      })
      .finally(() => {
        if (!cancelled) setBusy(null)
      })
    return () => { cancelled = true }
  }, [props.agentId, props.revisionId])

  function toggleTask(task: TaskTypeOption, checked: boolean) {
    setPolicy((current) => ({
      ...current,
      taskTypes: checked
        ? [...current.taskTypes.filter((item) => !(item.key === task.key && item.version === task.version)), { key: task.key, version: task.version }]
        : current.taskTypes.filter((item) => !(item.key === task.key && item.version === task.version)),
    }))
  }

  function setLimit(key: keyof OutreachPolicy['limits'], value: string) {
    setPolicy((current) => ({
      ...current,
      limits: {
        ...current.limits,
        [key]: key === 'workingHours' ? value : Math.max(0, Number(value) || 0),
      },
    }))
  }

  async function save() {
    setBusy('save')
    setNote(null)
    try {
      const res = await fetch(`/api/ai-agents/${props.agentId}/revisions/${props.revisionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationalMode: mode, outreachPolicy: policy }),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Save failed.')
      setNote('Outbound Builder settings saved to this draft revision.')
      props.onChanged()
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Save failed.')
    } finally {
      setBusy(null)
    }
  }

  async function preview() {
    setBusy('dry')
    setNote(null)
    try {
      const res = await fetch('/api/agent-task-types', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskTypes: policy.taskTypes, maxTargets: policy.limits.maxTargets }),
      })
      const json = await res.json() as Record<string, unknown> & { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Dry run failed.')
      setDryRun(json)
      setNote('Dry Run completed with no side effects.')
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Dry run failed.')
    } finally {
      setBusy(null)
    }
  }

  const field = 'h-9 rounded-md border bg-background px-3 text-sm'
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Outbound / Task Builder</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Operational mode is descriptive, not a permission. Runtime capabilities, tool grants, Task manifests and messaging policy remain authoritative.
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-xs font-medium">
            Operational mode
            <select className={field + ' w-full'} value={mode} onChange={(e) => setMode(e.target.value as OperationalMode)}>
              <option value="reactive">Reactive</option>
              <option value="outbound">Outbound</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Approval policy
            <select className={field + ' w-full'} value={policy.approvalMode} onChange={(e) => setPolicy((p) => ({ ...p, approvalMode: e.target.value as ApprovalMode }))}>
              <option value="none">No approval</option>
              <option value="task">Task-level approval</option>
              <option value="batch">Batch-level approval</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Target scope
            <select className={field + ' w-full'} value={policy.targetScope.kind} onChange={(e) => setPolicy((p) => ({ ...p, targetScope: { ...p.targetScope, kind: e.target.value } }))}>
              {scopeKinds.map((kind) => <option key={kind} value={kind}>{kind.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Registered Task Types</p>
          {taskTypes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No domain Task Types are registered yet. The Builder never accepts arbitrary task keys.</p>
          ) : taskTypes.map((task) => {
            const checked = policy.taskTypes.some((item) => item.key === task.key && item.version === task.version)
            return (
              <label key={task.key + '@' + task.version} className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <input type="checkbox" checked={checked} onChange={(e) => toggleTask(task, e.target.checked)} />
                <span><strong>{task.title}</strong><span className="ms-2 font-mono text-xs">{task.key}@{task.version}</span><br/><span className="text-xs text-muted-foreground">{task.description}</span></span>
              </label>
            )
          })}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-xs font-medium">Selector<Input value={policy.targetScope.selector} onChange={(e) => setPolicy((p) => ({ ...p, targetScope: { ...p.targetScope, selector: e.target.value } }))} placeholder="registered selector / filter key" /></label>
          <label className="space-y-1 text-xs font-medium">Values<Input value={policy.targetScope.values.join(', ')} onChange={(e) => setPolicy((p) => ({ ...p, targetScope: { ...p.targetScope, values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) } }))} placeholder="tag-a, region-b" /></label>
          <label className="space-y-1 text-xs font-medium">Working hours<Input value={policy.limits.workingHours} onChange={(e) => setLimit('workingHours', e.target.value)} /></label>
          {([
            ['maxTargets', 'Max targets'],
            ['maxAttempts', 'Max attempts'],
            ['followupCount', 'Follow-up count'],
            ['cooldownMinutes', 'Cooldown minutes'],
            ['dailyBudget', 'Daily budget'],
            ['tokenBudget', 'Token budget'],
            ['messageBudget', 'Message budget'],
          ] as const).map(([key, label]) => (
            <label key={key} className="space-y-1 text-xs font-medium">{label}<Input type="number" min={0} value={policy.limits[key]} onChange={(e) => setLimit(key, e.target.value)} /></label>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Save className="me-1.5 h-4 w-4" />}Save outbound settings
          </Button>
          <Button size="sm" variant="outline" onClick={() => void preview()} disabled={busy !== null}>
            {busy === 'dry' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <FlaskConical className="me-1.5 h-4 w-4" />}Dry Run
          </Button>
        </div>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        {dryRun ? (
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">{JSON.stringify(dryRun, null, 2)}</pre>
        ) : null}
      </CardContent>
    </Card>
  )
}
