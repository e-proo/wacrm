'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookOpen, Check, Loader2, Plus, RefreshCw, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface KnowledgeBaseOption {
  knowledge_base_id: string
  name: string
  slug: string
  description: string | null
  scope: 'shared' | 'agent_private' | 'service'
  status: 'draft' | 'active' | 'archived'
  trust_level: 'admin_verified' | 'internal' | 'external' | 'untrusted'
  assigned: boolean
  enabled: boolean
  priority: number
}

interface KnowledgeDraft {
  knowledge_base_id: string
  enabled: boolean
  priority: number
}

interface PanelMessage { kind: 'success' | 'error'; text: string }

/**
 * Knowledge v2 assignment editor. Admins assign whole managed KBs to a frozen
 * agent revision; chunks are an indexing implementation detail and never
 * selected manually. Published revisions are display-only/immutable.
 */
export function AgentKnowledgePanel({
  agentId,
  hasRevision,
}: {
  agentId: string
  hasRevision: boolean
}) {
  const t = useTranslations('Agents.multiAgent.agentKnowledge')
  const [open, setOpen] = useState(false)
  const [bases, setBases] = useState<KnowledgeBaseOption[] | null>(null)
  const [revision, setRevision] = useState<{ id: string; status: string } | null>(null)
  const [draft, setDraft] = useState<Map<string, KnowledgeDraft>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)
  const [privateName, setPrivateName] = useState('')
  const [message, setMessage] = useState<PanelMessage | null>(null)
  const msgRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (message) msgRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [message])

  const load = useCallback(async () => {
    const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, { cache: 'no-store' })
    if (!res.ok) {
      setBases([])
      setMessage({ kind: 'error', text: res.status === 429 ? t('rateLimited') : t('loadFailed') })
      return
    }
    const json = (await res.json()) as {
      revision: { id: string; status: string } | null
      knowledge_bases: KnowledgeBaseOption[]
    }
    const list = json.knowledge_bases ?? []
    setBases(list)
    setRevision(json.revision)
    setDraft(new Map(
      list
        .filter((base) => base.assigned)
        .map((base) => [base.knowledge_base_id, {
          knowledge_base_id: base.knowledge_base_id,
          enabled: base.enabled,
          priority: base.priority,
        }]),
    ))
  }, [agentId, t])

  useEffect(() => { if (open) void load() }, [open, load])

  const editable = revision?.status === 'draft'

  function toggle(base: KnowledgeBaseOption) {
    if (!editable || base.status === 'archived') return
    setDraft((prev) => {
      const next = new Map(prev)
      if (next.has(base.knowledge_base_id)) next.delete(base.knowledge_base_id)
      else next.set(base.knowledge_base_id, {
        knowledge_base_id: base.knowledge_base_id,
        enabled: true,
        priority: 100,
      })
      return next
    })
  }

  async function save() {
    if (!revision?.id || !editable) {
      setMessage({ kind: 'error', text: t('noRevision') })
      return
    }
    const count = draft.size
    setBusy('save')
    setMessage(null)
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: revision.id, assignments: [...draft.values()] }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string; assigned?: number }
      if (!res.ok || !json.ok) {
        throw new Error(res.status === 429 ? t('rateLimited') : (json.error ?? t('saveFailed')))
      }
      await load()
      setMessage({ kind: 'success', text: t('saved', { count: json.assigned ?? count }) })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : t('saveFailed') })
    } finally {
      setBusy(null)
    }
  }

  async function createPrivateBase() {
    const name = privateName.trim()
    if (!name) return
    setBusy('create-private')
    setMessage(null)
    try {
      const res = await fetch('/api/ai/knowledge-bases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          scope: 'agent_private',
          owner_agent_id: agentId,
          default_trust_level: 'internal',
        }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Failed to create private knowledge base')
      }
      setPrivateName('')
      await load()
      setMessage({
        kind: 'success',
        text: 'Private knowledge base created as draft. Add and review its documents, activate it, then assign it to a draft revision.',
      })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to create private knowledge base',
      })
    } finally {
      setBusy(null)
    }
  }

  async function assignAllActive() {
    if (!editable) {
      setMessage({ kind: 'error', text: t('noRevision') })
      return
    }
    setBusy('sync')
    setMessage(null)
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/knowledge`, { method: 'POST' })
      const json = (await res.json()) as { ok?: boolean; error?: string; synced?: number; total?: number }
      if (!res.ok || !json.ok) {
        throw new Error(res.status === 429 ? t('rateLimited') : (json.error ?? t('syncFailed')))
      }
      await load()
      setMessage({ kind: 'success', text: t('synced', { synced: json.synced ?? 0, total: json.total ?? 0 }) })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : t('syncFailed') })
    } finally {
      setBusy(null)
    }
  }

  if (!hasRevision) return null

  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
        {open ? <X className="me-1.5 h-4 w-4" /> : <BookOpen className="me-1.5 h-4 w-4" />}
        {t('title', { count: draft.size })}
      </Button>
      {open ? (
        <div className="mt-2 space-y-2 rounded border p-3">
          {message ? (
            <p
              ref={msgRef}
              className={`flex items-center gap-1.5 text-xs font-medium ${message.kind === 'error' ? 'text-destructive' : 'text-foreground'}`}
            >
              {message.kind === 'success' ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
              {message.text}
            </p>
          ) : null}
          <div className="space-y-1.5 rounded border border-dashed p-2">
            <p className="text-xs font-medium">Agent-private knowledge</p>
            <p className="text-[11px] text-muted-foreground">
              Create a dynamic knowledge base owned by this agent. It cannot be assigned to another agent.
            </p>
            <div className="flex gap-2">
              <Input
                value={privateName}
                onChange={(event) => setPrivateName(event.target.value)}
                placeholder="Private knowledge base name"
                className="h-8 text-xs"
                disabled={busy === 'create-private'}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void createPrivateBase()}
                disabled={!privateName.trim() || busy === 'create-private'}
              >
                {busy === 'create-private' ? (
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="me-1.5 h-4 w-4" />
                )}
                Create
              </Button>
            </div>
          </div>
          {revision && !editable ? (
            <p className="rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              Knowledge assignments are frozen on a published revision. Create/edit a draft revision to change them.
            </p>
          ) : null}
          {bases === null ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : bases.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <>
              <div className="max-h-72 space-y-1 overflow-auto">
                {bases.map((base) => {
                  const selected = draft.has(base.knowledge_base_id)
                  const disabled = !editable || base.status === 'archived'
                  return (
                    <button
                      key={base.knowledge_base_id}
                      type="button"
                      disabled={disabled}
                      className={`flex w-full items-start gap-2 rounded border px-2 py-2 text-start text-xs transition-colors ${
                        selected ? 'border-primary bg-primary/10' : 'hover:bg-muted/40'
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                      onClick={() => toggle(base)}
                    >
                      <span className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-sm border ${selected ? 'border-primary bg-primary' : 'border-muted-foreground'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{base.name}</span>
                        <span className="block truncate text-muted-foreground">
                          {base.scope} · {base.status} · {base.trust_level}
                          {base.description ? ` · ${base.description}` : ''}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void save()} disabled={busy === 'save' || !editable}>
                  {busy === 'save' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Save className="me-1.5 h-4 w-4" />}
                  {t('save')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void assignAllActive()} disabled={busy === 'sync' || !editable}>
                  {busy === 'sync' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="me-1.5 h-4 w-4" />}
                  {t('sync')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
