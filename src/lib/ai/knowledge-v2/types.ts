export type KnowledgeBaseScope = 'shared' | 'agent_private' | 'service'
export type KnowledgeBaseStatus = 'draft' | 'active' | 'archived'
export type KnowledgeSourceType = 'manual' | 'upload' | 'url' | 'api' | 'integration'
export type KnowledgeLifecycleStatus =
  | 'draft'
  | 'reviewed'
  | 'active'
  | 'superseded'
  | 'archived'
  | 'quarantined'
export type KnowledgeTrustLevel = 'admin_verified' | 'internal' | 'external' | 'untrusted'
export type KnowledgeInjectionRisk = 'none' | 'suspected' | 'high'

export interface KnowledgeBaseRecord {
  id: string
  account_id: string
  name: string
  slug: string
  description: string | null
  scope: KnowledgeBaseScope
  owner_agent_id: string | null
  status: KnowledgeBaseStatus
  default_trust_level: KnowledgeTrustLevel
}

export interface KnowledgeDocumentInput {
  title: string
  content: string
  sourceType: KnowledgeSourceType
  sourceUri?: string | null
  trustLevel?: KnowledgeTrustLevel
  language?: string
  effectiveFrom?: string | null
  effectiveUntil?: string | null
}

export interface KnowledgeExcerpt {
  chunkId: string
  documentId: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  documentTitle: string
  content: string
  trustLevel: KnowledgeTrustLevel
  sourceType: KnowledgeSourceType
  language: string
  updatedAt: string
  score: number
  retrieval: 'semantic' | 'lexical'
}

export interface KnowledgeRetrievalScope {
  accountId: string
  agentRevisionId: string
  serviceId?: string | null
  language?: string | null
}
