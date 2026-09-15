'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Archive, BookOpen, CheckCircle2, Loader2, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslations } from 'next-intl'

type BaseStatus = 'draft' | 'active' | 'archived'
type BaseScope = 'shared' | 'agent_private' | 'service'
type DocStatus = 'draft' | 'reviewed' | 'active' | 'superseded' | 'archived' | 'quarantined'

interface KnowledgeBaseSummary {
  id: string
  name: string
  slug: string
  description: string | null
  scope: BaseScope
  owner_agent_id: string | null
  status: BaseStatus
  default_trust_level: string
}

interface KnowledgeDocumentSummary {
  id: string
  title: string
  source_type: string
  source_uri: string | null
  lifecycle_status: DocStatus
  trust_level: string
  language: string
  injection_risk: 'none' | 'suspected' | 'high'
  updated_at: string
}

/**
 * Account-level dynamic knowledge manager. Source-code/project files are not a
 * supported knowledge source; all content is managed through the runtime data
 * model and must pass lifecycle review before retrieval.
 */
export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null
  canEdit: boolean
  hasEmbeddingsKey: boolean
}) {
  const t = useTranslations('Settings.aiKnowledge')
  const loadedAccountIdRef = useRef<string | null>(null)
  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([])
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [newBaseName, setNewBaseName] = useState('')
  const [newBaseDescription, setNewBaseDescription] = useState('')
  const [showBaseForm, setShowBaseForm] = useState(false)
  const [showDocForm, setShowDocForm] = useState(false)
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})

  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null

  const loadBases = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai/knowledge-bases', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('loadFailed'))
      const list = (data.knowledge_bases ?? []) as KnowledgeBaseSummary[]
      setBases(list)
      setSelectedBaseId((current) =>
        current && list.some((base) => base.id === current) ? current : (list[0]?.id ?? null),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadDocuments = useCallback(async (baseId: string | null) => {
    if (!baseId) {
      setDocuments([])
      return
    }
    setLoadingDocs(true)
    try {
      const res = await fetch(`/api/ai/knowledge-bases/${baseId}/documents`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('loadFailed'))
      setDocuments((data.documents ?? []) as KnowledgeDocumentSummary[])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoadingDocs(false)
    }
  }, [t])

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return
    loadedAccountIdRef.current = accountId
    void loadBases()
  }, [accountId, loadBases])

  useEffect(() => { void loadDocuments(selectedBaseId) }, [selectedBaseId, loadDocuments])

  async function createBase() {
    if (!newBaseName.trim()) return
    setBusy('create-base')
    try {
      const res = await fetch('/api/ai/knowledge-bases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newBaseName.trim(),
          description: newBaseDescription.trim() || null,
          scope: 'shared',
          default_trust_level: 'internal',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('saveFailed'))
      setNewBaseName('')
      setNewBaseDescription('')
      setShowBaseForm(false)
      await loadBases()
      setSelectedBaseId(data.id)
      toast.success('Knowledge base created as draft')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function setBaseStatus(status: BaseStatus) {
    if (!selectedBase) return
    setBusy(`base-${status}`)
    try {
      const res = await fetch(`/api/ai/knowledge-bases/${selectedBase.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('saveFailed'))
      await loadBases()
      toast.success(`Knowledge base is now ${status}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function createDocument() {
    if (!selectedBase || !docTitle.trim() || !docContent.trim()) return
    setBusy('create-doc')
    try {
      const res = await fetch(`/api/ai/knowledge-bases/${selectedBase.id}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: docTitle.trim(),
          content: docContent.trim(),
          source_type: 'manual',
          trust_level: selectedBase.default_trust_level,
          language: 'auto',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('saveFailed'))
      setDocTitle('')
      setDocContent('')
      setShowDocForm(false)
      await loadDocuments(selectedBase.id)
      if (data.injectionRisk === 'high') toast.warning('Document was quarantined for review')
      else toast.success('Document saved as draft; review and activate it before agents can use it')
      if (data.indexingWarning) toast.warning(data.indexingWarning)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function setDocumentStatus(documentId: string, status: 'reviewed' | 'active' | 'archived' | 'quarantined') {
    if (!selectedBase) return
    setBusy(`doc-${documentId}-${status}`)
    try {
      const res = await fetch(`/api/ai/knowledge-bases/${selectedBase.id}/documents/${documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status,
          ...(status === 'reviewed' ? { review_notes: reviewNotes[documentId]?.trim() || null } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? t('saveFailed'))
      await loadDocuments(selectedBase.id)
      if (status === 'reviewed') setReviewNotes((current) => ({ ...current, [documentId]: '' }))
      toast.success(`Document is now ${status}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function removeDocument(documentId: string) {
    if (!selectedBase) return
    setBusy(`delete-${documentId}`)
    try {
      const res = await fetch(`/api/ai/knowledge/${documentId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? t('removeFailed'))
      await loadDocuments(selectedBase.id)
      toast.success(t('removeSuccess'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('removeFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function reindex() {
    setBusy('reindex')
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error ?? t('reindexFailed'))
      toast.success(t('reindexSuccess', { count: data.reindexed }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('reindexFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>
          Dynamic knowledge bases. Agents use only bases explicitly assigned to their published revision.{' '}
          {hasEmbeddingsKey ? t('semanticSearchOn') : t('keywordSearchOn')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="me-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Knowledge bases</p>
                  {canEdit ? (
                    <Button size="sm" variant="outline" onClick={() => setShowBaseForm((value) => !value)}>
                      <Plus className="me-1 h-3.5 w-3.5" /> New
                    </Button>
                  ) : null}
                </div>
                {showBaseForm ? (
                  <div className="space-y-2 rounded-md border p-2">
                    <Input value={newBaseName} onChange={(event) => setNewBaseName(event.target.value)} placeholder="Knowledge base name" />
                    <Input value={newBaseDescription} onChange={(event) => setNewBaseDescription(event.target.value)} placeholder="Description (optional)" />
                    <Button size="sm" onClick={() => void createBase()} disabled={!newBaseName.trim() || busy === 'create-base'}>
                      {busy === 'create-base' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
                      Create draft
                    </Button>
                  </div>
                ) : null}
                {bases.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No knowledge bases yet.</p>
                ) : (
                  <div className="space-y-1">
                    {bases.map((base) => (
                      <button
                        key={base.id}
                        type="button"
                        onClick={() => setSelectedBaseId(base.id)}
                        className={`w-full rounded-md border px-3 py-2 text-start text-sm ${selectedBaseId === base.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}
                      >
                        <span className="block truncate font-medium">{base.name}</span>
                        <span className="block text-xs text-muted-foreground">{base.scope} · {base.status} · {base.default_trust_level}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {!selectedBase ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Select a knowledge base.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3">
                      <div>
                        <p className="font-medium">{selectedBase.name}</p>
                        <p className="text-xs text-muted-foreground">{selectedBase.description ?? 'No description'}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{selectedBase.scope} · {selectedBase.status}</p>
                      </div>
                      {canEdit ? (
                        <div className="flex gap-2">
                          {selectedBase.status !== 'active' ? (
                            <Button size="sm" onClick={() => void setBaseStatus('active')} disabled={busy !== null}>
                              <CheckCircle2 className="me-1 h-3.5 w-3.5" /> Activate base
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => void setBaseStatus('archived')} disabled={busy !== null}>
                              <Archive className="me-1 h-3.5 w-3.5" /> Archive base
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">Documents</p>
                      <div className="flex gap-2">
                        {hasEmbeddingsKey ? (
                          <Button size="sm" variant="ghost" onClick={() => void reindex()} disabled={busy === 'reindex'}>
                            <RefreshCw className={`me-1 h-3.5 w-3.5 ${busy === 'reindex' ? 'animate-spin' : ''}`} /> Reindex
                          </Button>
                        ) : null}
                        {canEdit ? (
                          <Button size="sm" variant="outline" onClick={() => setShowDocForm((value) => !value)}>
                            <Plus className="me-1 h-3.5 w-3.5" /> Add document
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {showDocForm ? (
                      <div className="space-y-3 rounded-md border p-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="kb-v2-title">Title</Label>
                          <Input id="kb-v2-title" value={docTitle} onChange={(event) => setDocTitle(event.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="kb-v2-content">Content</Label>
                          <Textarea id="kb-v2-content" rows={8} value={docContent} onChange={(event) => setDocContent(event.target.value)} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          New content is never active automatically. Injection-like text may be quarantined for review.
                        </p>
                        <Button size="sm" onClick={() => void createDocument()} disabled={!docTitle.trim() || !docContent.trim() || busy === 'create-doc'}>
                          {busy === 'create-doc' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
                          Save draft
                        </Button>
                      </div>
                    ) : null}

                    {loadingDocs ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : documents.length === 0 ? (
                      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No documents in this base.</p>
                    ) : (
                      <ul className="space-y-2">
                        {documents.map((doc) => (
                          <li key={doc.id} className="rounded-md border p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{doc.title}</p>
                                <p className="text-xs text-muted-foreground">
                                  {doc.source_type} · {doc.lifecycle_status} · {doc.trust_level} · {doc.language}
                                </p>
                                {doc.injection_risk !== 'none' ? (
                                  <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                                    <ShieldAlert className="h-3.5 w-3.5" /> Injection risk: {doc.injection_risk}
                                  </p>
                                ) : null}
                              </div>
                              {canEdit ? (
                                <div className="flex min-w-[220px] flex-col items-end gap-1">
                                  {doc.lifecycle_status === 'draft' || doc.lifecycle_status === 'quarantined' ? (
                                    <div className="flex w-full flex-col gap-1">
                                      <Input
                                        value={reviewNotes[doc.id] ?? ''}
                                        onChange={(event) => setReviewNotes((current) => ({ ...current, [doc.id]: event.target.value }))}
                                        placeholder={doc.injection_risk === 'high' ? 'Review notes required for high-risk content' : 'Review notes (optional)'}
                                        className="h-8 text-xs"
                                        disabled={busy !== null}
                                      />
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => void setDocumentStatus(doc.id, 'reviewed')}
                                        disabled={busy !== null || (doc.injection_risk === 'high' && !(reviewNotes[doc.id] ?? '').trim())}
                                      >
                                        Review
                                      </Button>
                                    </div>
                                  ) : null}
                                  <div className="flex flex-wrap justify-end gap-1">
                                    {doc.lifecycle_status === 'reviewed' ? (
                                      <Button size="sm" variant="outline" onClick={() => void setDocumentStatus(doc.id, 'active')} disabled={busy !== null}>
                                        Activate
                                      </Button>
                                    ) : null}
                                    {doc.lifecycle_status === 'active' ? (
                                      <Button size="sm" variant="outline" onClick={() => void setDocumentStatus(doc.id, 'archived')} disabled={busy !== null}>
                                        Archive
                                      </Button>
                                    ) : null}
                                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void removeDocument(doc.id)} disabled={busy !== null}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
