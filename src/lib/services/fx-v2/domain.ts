import { SYSTEM_MESSAGE_TEMPLATES } from '@/lib/messaging/defaults'
import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { FX_V2_CHANGE_EXECUTORS } from './change-executors'
import { FX_V2_TOOL_MANIFESTS } from './tool-manifests'

const FX_TEMPLATE_KEYS = new Set([
  'exchange_rate.quote.completed',
  'exchange_rate.trade.requested',
  'exchange_rate.trade.approved',
  'exchange_rate.trade.rejected',
  'exchange_rate.trade.completed',
])

const fxTemplates = SYSTEM_MESSAGE_TEMPLATES.filter((template) => FX_TEMPLATE_KEYS.has(template.key))
if (fxTemplates.length !== FX_TEMPLATE_KEYS.size) {
  throw new Error('FX V2 domain is missing one or more system message templates.')
}

export const FX_V2_DOMAIN = defineBusinessDomain({
  key: 'exchange_rates',
  version: 1,
  title: 'Exchange Rates V2',
  description:
    'Authoritative FX V2 domain: current-rate reads, trade proposals, admin proposals, deterministic approved writes, and canonical trade events.',
  capabilities: ['rates.read', 'rates.trade_request', 'rates.propose'],
  tools: FX_V2_TOOL_MANIFESTS,
  changeActions: [
    {
      key: 'exchange_rates.pair.publish',
      version: 1,
      domain: 'exchange_rates',
      title: 'Publish approved FX rate version',
      description:
        'Deterministically publishes a new immutable FX V2 rate version from an approved pair-change proposal.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [{ targetType: 'fx_rate_pair', intent: 'update', targetId: 'present' }],
    },
    {
      key: 'exchange_rates.trade.decide',
      version: 1,
      domain: 'exchange_rates',
      title: 'Apply approved FX trade decision',
      description:
        'Deterministically approves-for-contact or rejects a pending FX V2 trade request after explicit approval.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'fx_trade_request', intent: 'update', targetId: 'present' },
      ],
    },
  ],
  events: [
    {
      key: 'exchange_rate.trade.requested',
      version: 1,
      domain: 'exchange_rates',
      title: 'FX trade requested',
      description: 'A customer FX trade request entered the admin review lifecycle.',
      subjectTypes: ['fx_trade_request'],
      snapshotPolicy: 'immutable_subject_reference',
    },
    {
      key: 'exchange_rate.trade.approved',
      version: 1,
      domain: 'exchange_rates',
      title: 'FX trade approved for contact',
      description: 'Administration approved a pending FX trade request for customer contact.',
      subjectTypes: ['fx_trade_request'],
      snapshotPolicy: 'immutable_subject_reference',
    },
    {
      key: 'exchange_rate.trade.rejected',
      version: 1,
      domain: 'exchange_rates',
      title: 'FX trade rejected',
      description: 'Administration rejected a pending FX trade request.',
      subjectTypes: ['fx_trade_request'],
      snapshotPolicy: 'immutable_subject_reference',
    },
    {
      key: 'exchange_rate.trade.completed',
      version: 1,
      domain: 'exchange_rates',
      title: 'FX trade completed',
      description: 'An approved FX trade request was recorded as completed.',
      subjectTypes: ['fx_trade_request'],
      snapshotPolicy: 'immutable_subject_reference',
    },
  ],
  messageTemplates: fxTemplates,
})

export const FX_V2_RUNTIME = defineBusinessDomainRuntime({
  key: 'exchange_rates',
  version: 1,
  toolExecutors: [],
  changeExecutors: FX_V2_CHANGE_EXECUTORS,
  eventProjectors: [],
})
