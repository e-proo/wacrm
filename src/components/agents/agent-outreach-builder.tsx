'use client'

import { useEffect, useState } from 'react'
import { FlaskConical, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type OperationalMode = 'reactive' | 'outbound' | 'both'
type ApprovalMode = 'none' | 'task' | 'batch'

interface TargetScope {
  requiredTagIds: string[]
  excludedTagIds: string[]
  serviceIds: string[]
  regionIds: string[]
  domainSelector: {
    key: string
    params: Record<string, unknown>
  } | null
}

interface WorkingHours {
  enabled: boolean
  timezone: string
  weekdays: number[]
  start: string
  end: string
}

interface TaskBinding {
  taskType: string
  taskTypeVersion: number
  targetScope: TargetScope
  maxTargets: number
  maxAttemptsPerTarget: number
  maxFollowups: number
  cooldownMinutes: number
  maxNewContactsPerHour: number
  maxContactsPerAgentPerDay: number
  workingHours: WorkingHours
  dailyMessageBudget: number
  dailyTokenBudget: number
  approvalMode: ApprovalMode
}

interface TaskTypeOption {
  key: string
  version: number
  domain: string
  title: string
  description: string
  requiredTaskApproval: ApprovalMode
  maxTargets: number
  defaultBinding: TaskBinding | null
}

interface DryRunResult {
  dryRun?: boolean
  sideEffects?: boolean
  validation?: {
    ok: boolean
    issues: Array<{ path: string; code: string; message: string }>
  }
  selectedTargets?: unknown[]
  skippedTargets?: unknown[]
  skippedReasons?: unknown[]
  sampleGeneratedMessages?: unknown[]
  toolsCalled?: unknown[]
  estimatedCost?: number | null
  estimatedSendCount?: number
  policyWarnings?: unknown[]
  note?: string
  error?: string
}

function parseBindings(value: unknown): TaskBinding[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const bindings = (value as { bindings?: unknown }).bindings
  return Array.isArray(bindings) ? (bindings as TaskBinding[]) : []
}

function csv(value: readonly string[]) {
  return value.join(', ')
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function approvalOptions(required: ApprovalMode): ApprovalMode[] {
  if (required === 'batch') return ['batch']
  if (required === 'task') return ['task', 'batch']
  return ['none', 'task', 'batch']
}

export function AgentOutreachBuilder(props: {
  agentId: string
  revisionId: string
  onChanged: () => void
}) {
  const [mode, setMode] = useState<OperationalMode>('reactive')
  const [bindings, setBindings] = useState<TaskBinding[]>([])
  const [taskTypes, setTaskTypes] = useState<TaskTypeOption[]>([])
  const [busy, setBusy] = useState<'load' | 'save' | 'dry' | null>('load')
  const [note, setNote] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setBusy('load')
    Promise.all([
      fetch(
        `/api/ai-agents/${props.agentId}/revisions/${props.revisionId}`,
        { cache: 'no-store' },
      ),
      fetch('/api/agent-task-types', { cache: 'no-store' }),
    ])
      .then(async ([revisionRes, catalogRes]) => {
        if (!revisionRes.ok || !catalogRes.ok) {
          throw new Error('Failed to load outbound Builder settings.')
        }
        const revisionJson = (await revisionRes.json()) as {
          revision: {
            operational_mode?: OperationalMode
            outreach_policy?: unknown
          }
        }
        const catalogJson = (await catalogRes.json()) as {
          taskTypes?: TaskTypeOption[]
        }
        if (cancelled) return

        setMode(revisionJson.revision.operational_mode ?? 'reactive')
        setBindings(parseBindings(revisionJson.revision.outreach_policy))
        setTaskTypes(catalogJson.taskTypes ?? [])
      })
      .catch((error) => {
        if (!cancelled) {
          setNote(error instanceof Error ? error.message : 'Load failed.')
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null)
      })

    return () => {
      cancelled = true
    }
  }, [props.agentId, props.revisionId])

  function selectMode(next: OperationalMode) {
    setMode(next)
    if (next === 'reactive') setBindings([])
    setDryRun(null)
  }

  function toggleTask(task: TaskTypeOption, checked: boolean) {
    setDryRun(null)
    setBindings((current) => {
      const exists = current.some(
        (binding) =>
          binding.taskType === task.key &&
          binding.taskTypeVersion === task.version,
      )
      if (!checked) {
        return current.filter(
          (binding) =>
            !(
              binding.taskType === task.key &&
              binding.taskTypeVersion === task.version
            ),
        )
      }
      if (exists || !task.defaultBinding) return current
      return [...current, task.defaultBinding]
    })
  }

  function updateBinding(
    taskType: string,
    taskTypeVersion: number,
    updater: (binding: TaskBinding) => TaskBinding,
  ) {
    setDryRun(null)
    setBindings((current) =>
      current.map((binding) =>
        binding.taskType === taskType &&
        binding.taskTypeVersion === taskTypeVersion
          ? updater(binding)
          : binding,
      ),
    )
  }

  async function save() {
    setBusy('save')
    setNote(null)
    try {
      const res = await fetch(
        `/api/ai-agents/${props.agentId}/revisions/${props.revisionId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            operationalMode: mode,
            outreachPolicy: { bindings },
          }),
        },
      )
      const json = (await res.json()) as {
        error?: string
        builder?: { capabilities?: string[] }
        checks?: Array<{ message?: string }>
      }
      if (!res.ok) {
        const details = json.checks
          ?.map((check) => check.message)
          .filter(Boolean)
          .join('; ')
        throw new Error(details || json.error || 'Save failed.')
      }

      const capabilities = json.builder?.capabilities?.length ?? 0
      setNote(
        `Builder settings saved atomically with ${capabilities} derived capabilities.`,
      )
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
        body: JSON.stringify({ operationalMode: mode, bindings }),
      })
      const json = (await res.json()) as DryRunResult
      if (!res.ok) throw new Error(json.error ?? 'Dry run failed.')
      setDryRun(json)
      setNote('Dry Run completed with no sends or business-data changes.')
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Dry run failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Outbound / Task Builder</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Operational mode is descriptive, not a permission. Saved bindings are
          validated against registered Task Types, frozen tool grants and
          derived revision capabilities.
        </p>

        <label className="block max-w-sm space-y-1 text-xs font-medium">
          Operational mode
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={mode}
            onChange={(event) =>
              selectMode(event.target.value as OperationalMode)
            }
          >
            <option value="reactive">Reactive</option>
            <option value="outbound">Outbound</option>
            <option value="both">Both</option>
          </select>
        </label>

        {mode !== 'reactive' ? (
          <section className="space-y-2">
            <p className="text-xs font-medium">Registered Task Types</p>
            {taskTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No domain Task Types are registered yet. Outbound publication
                remains blocked until a registered Task Type exists.
              </p>
            ) : (
              taskTypes.map((task) => {
                const checked = bindings.some(
                  (binding) =>
                    binding.taskType === task.key &&
                    binding.taskTypeVersion === task.version,
                )
                return (
                  <label
                    key={`${task.key}@${task.version}`}
                    className="flex items-start gap-2 rounded-md border p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!task.defaultBinding}
                      onChange={(event) =>
                        toggleTask(task, event.target.checked)
                      }
                    />
                    <span>
                      <strong>{task.title}</strong>
                      <span className="ms-2 font-mono text-xs">
                        {task.key}@{task.version}
                      </span>
                      <br />
                      <span className="text-xs text-muted-foreground">
                        {task.description}
                      </span>
                    </span>
                  </label>
                )
              })
            )}
          </section>
        ) : null}

        {bindings.map((binding) => {
          const task = taskTypes.find(
            (item) =>
              item.key === binding.taskType &&
              item.version === binding.taskTypeVersion,
          )
          const approvalModes = approvalOptions(
            task?.requiredTaskApproval ?? 'none',
          )
          const patch = (changes: Partial<TaskBinding>) =>
            updateBinding(
              binding.taskType,
              binding.taskTypeVersion,
              (current) => ({ ...current, ...changes }),
            )
          const patchScope = (changes: Partial<TargetScope>) =>
            patch({
              targetScope: { ...binding.targetScope, ...changes },
            })
          const patchHours = (changes: Partial<WorkingHours>) =>
            patch({
              workingHours: { ...binding.workingHours, ...changes },
            })

          return (
            <section
              key={`${binding.taskType}@${binding.taskTypeVersion}`}
              className="space-y-4 rounded-md border p-4"
            >
              <div>
                <p className="text-sm font-semibold">
                  {task?.title ?? binding.taskType}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {binding.taskType}@{binding.taskTypeVersion}
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <NumberField
                  label="Max targets"
                  value={binding.maxTargets}
                  min={1}
                  max={task?.maxTargets}
                  onChange={(value) => patch({ maxTargets: value })}
                />
                <NumberField
                  label="Max attempts / target"
                  value={binding.maxAttemptsPerTarget}
                  min={1}
                  max={20}
                  onChange={(value) =>
                    patch({ maxAttemptsPerTarget: value })
                  }
                />
                <NumberField
                  label="Max follow-ups"
                  value={binding.maxFollowups}
                  min={0}
                  onChange={(value) => patch({ maxFollowups: value })}
                />
                <NumberField
                  label="Cooldown minutes"
                  value={binding.cooldownMinutes}
                  min={0}
                  onChange={(value) => patch({ cooldownMinutes: value })}
                />
                <NumberField
                  label="New contacts / hour"
                  value={binding.maxNewContactsPerHour}
                  min={1}
                  onChange={(value) =>
                    patch({ maxNewContactsPerHour: value })
                  }
                />
                <NumberField
                  label="Contacts / agent / day"
                  value={binding.maxContactsPerAgentPerDay}
                  min={1}
                  onChange={(value) =>
                    patch({ maxContactsPerAgentPerDay: value })
                  }
                />
                <NumberField
                  label="Daily message budget"
                  value={binding.dailyMessageBudget}
                  min={1}
                  onChange={(value) =>
                    patch({ dailyMessageBudget: value })
                  }
                />
                <NumberField
                  label="Daily token budget"
                  value={binding.dailyTokenBudget}
                  min={1}
                  onChange={(value) => patch({ dailyTokenBudget: value })}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  label="Required tag UUIDs"
                  value={csv(binding.targetScope.requiredTagIds)}
                  onChange={(value) =>
                    patchScope({ requiredTagIds: parseCsv(value) })
                  }
                />
                <TextField
                  label="Excluded tag UUIDs"
                  value={csv(binding.targetScope.excludedTagIds)}
                  onChange={(value) =>
                    patchScope({ excludedTagIds: parseCsv(value) })
                  }
                />
                <TextField
                  label="Service UUIDs"
                  value={csv(binding.targetScope.serviceIds)}
                  onChange={(value) =>
                    patchScope({ serviceIds: parseCsv(value) })
                  }
                />
                <TextField
                  label="Region UUIDs"
                  value={csv(binding.targetScope.regionIds)}
                  onChange={(value) =>
                    patchScope({ regionIds: parseCsv(value) })
                  }
                />
                <TextField
                  label="Domain selector key"
                  value={binding.targetScope.domainSelector?.key ?? ''}
                  onChange={(value) =>
                    patchScope({
                      domainSelector: value
                        ? {
                            key: value,
                            params:
                              binding.targetScope.domainSelector?.params ?? {},
                          }
                        : null,
                    })
                  }
                />
                <label className="space-y-1 text-xs font-medium">
                  Approval policy
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={binding.approvalMode}
                    onChange={(event) =>
                      patch({
                        approvalMode: event.target.value as ApprovalMode,
                      })
                    }
                  >
                    {approvalModes.map((approvalMode) => (
                      <option key={approvalMode} value={approvalMode}>
                        {approvalMode === 'none'
                          ? 'No approval'
                          : approvalMode === 'task'
                            ? 'Task-level approval'
                            : 'Batch-level approval'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={binding.workingHours.enabled}
                    onChange={(event) =>
                      patchHours({ enabled: event.target.checked })
                    }
                  />
                  Enforce working hours
                </label>
                <TextField
                  label="Timezone"
                  value={binding.workingHours.timezone}
                  onChange={(value) => patchHours({ timezone: value })}
                />
                <TextField
                  label="Start"
                  value={binding.workingHours.start}
                  onChange={(value) => patchHours({ start: value })}
                />
                <TextField
                  label="End"
                  value={binding.workingHours.end}
                  onChange={(value) => patchHours({ end: value })}
                />
                <TextField
                  label="Weekdays (0-6)"
                  value={binding.workingHours.weekdays.join(', ')}
                  onChange={(value) =>
                    patchHours({
                      weekdays: parseCsv(value)
                        .map(Number)
                        .filter((day) => Number.isInteger(day)),
                    })
                  }
                />
              </div>
            </section>
          )
        })}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy !== null}
          >
            {busy === 'save' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Save className="me-1.5 h-4 w-4" />
            )}
            Save outbound settings
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void preview()}
            disabled={busy !== null}
          >
            {busy === 'dry' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <FlaskConical className="me-1.5 h-4 w-4" />
            )}
            Dry Run
          </Button>
        </div>

        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}

        {dryRun ? (
          <div className="space-y-2">
            <p className="text-xs font-medium">
              Estimated send count: {dryRun.estimatedSendCount ?? 0}
            </p>
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
              {JSON.stringify(dryRun, null, 2)}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function NumberField(props: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  return (
    <label className="space-y-1 text-xs font-medium">
      {props.label}
      <Input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  )
}

function TextField(props: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="space-y-1 text-xs font-medium">
      {props.label}
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}
