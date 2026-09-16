import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderCoverageApprovedCustomerMessage } from '@/lib/messaging/coverage-customer'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import { publishPricingRuleRaw } from '@/lib/services/pricing/rules-crud'
import {
  decideFxTradeRequest,
  FxServiceError,
  publishFxRateVersion,
} from '@/lib/services/fx-v2/service'
import { readCoverageAttributes, type CoverageAttributes } from '@/lib/services/coverage/attributes'
import { compileFieldSchema, validateValues, type FieldDefinitionInput } from '@/lib/services/catalog/field-schema'

export class ChangeExecutionError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ChangeExecutionError'
    this.code = code
    this.status = status
  }
}

interface ClaimedChange {
  id: string
  target_type: string
  target_id: string | null
  intent: string
  proposed_payload: Record<string, unknown>
  expected_version: number | null
  content_digest: string
  claim_token: string
}

interface CoverageNotificationPayload {
  kind: 'offer' | 'request'
  entity_id?: string | null
  reference?: string | null
  service_id?: string | null
  amount: string
  currency: string
  attributes: CoverageAttributes
  commission_per_thousand?: string | null
  commission_currency?: string | null
}

interface CustomerNotificationDescriptor {
  intent_id?: string
  event_type?: string
  message_text?: string
  template_event?: string
  template_payload?: CoverageNotificationPayload
}

export async function executeApprovedChangeRequest(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
}): Promise<Record<string, unknown>> {
  const db = supabaseAdmin()
  const { data: claimedRows, error: claimError } = await db.rpc(
    'claim_change_request_execution',
    {
      p_account_id: input.accountId,
      p_change_request_id: input.changeRequestId,
    },
  )
  if (claimError) {
    throw new ChangeExecutionError(
      mapClaimError(claimError.message ?? ''),
      claimError.message ?? 'Could not claim change request.',
    )
  }
  const row = (claimedRows as ClaimedChange[] | null)?.[0]
  if (!row) {
    const { data: current, error } = await db
      .from('change_requests')
      .select('status, execution_result')
      .eq('account_id', input.accountId)
      .eq('id', input.changeRequestId)
      .maybeSingle()
    if (error) throw error
    if (current?.status === 'executed') {
      return {
        status: 'executed',
        id: input.changeRequestId,
        idempotent: true,
        ...((current.execution_result as Record<string, unknown> | null) ?? {}),
      }
    }
    throw new ChangeExecutionError('EXECUTION_CLAIM_LOST', 'Change request could not be claimed.')
  }

  try {
    await assertExpectedVersion(db, input.accountId, row)
    const result = await executeClaimedTarget(input, row)
    const { data: completed, error: completeError } = await db.rpc(
      'complete_change_request_execution',
      {
        p_account_id: input.accountId,
        p_change_request_id: row.id,
        p_claim_token: row.claim_token,
        p_result: result,
      },
    )
    if (completeError) throw completeError
    if (completed !== true) {
      throw new ChangeExecutionError(
        'EXECUTION_COMPLETION_CONFLICT',
        'The change was applied but completion ownership was lost; reconcile before retrying.',
        500,
      )
    }

    await db.rpc('append_service_activity_event', {
      p_account_id: input.accountId,
      p_target_type: 'change_request',
      p_target_id: row.id,
      p_event_type: 'change_request.executed',
      p_actor_type: 'user',
      p_actor_id: input.actorUserId ?? '',
      p_payload: result,
    })
    try {
      await enqueueCustomerNotification(db, input.accountId, row.id, result)
    } catch (notifyErr) {
      console.error('[change request] could not enqueue customer notification:', notifyErr)
    }
    return { ...result, status: 'executed' }
  } catch (err) {
    const code = err instanceof ChangeExecutionError ? err.code : 'EXECUTION_FAILED'
    const { error: failError } = await db.rpc('fail_change_request_execution', {
      p_account_id: input.accountId,
      p_change_request_id: row.id,
      p_claim_token: row.claim_token,
      p_error_code: code,
    })
    if (failError) console.error('[change request] failed to persist execution failure:', failError)
    throw err
  }
}

async function executeClaimedTarget(
  input: { accountId: string; changeRequestId: string; actorUserId: string | null },
  row: ClaimedChange,
): Promise<Record<string, unknown>> {
  if (row.target_type === 'pricing_rule' && row.intent === 'create_and_attach' && !row.target_id) {
    const p = row.proposed_payload as {
      service_id?: string
      expected_service_version?: number
      expected_current_revision_id?: string
      name?: string
      kind?: string
      fee_currency?: string | null
      input_currency?: string | null
      minimum_fee?: string | null
      maximum_fee?: string | null
      rounding_mode?: string | null
      formula_config?: Record<string, unknown>
    }
    if (
      !p.service_id || p.expected_service_version == null || !p.expected_current_revision_id ||
      !p.name || !p.kind || !p.formula_config
    ) {
      throw new ChangeExecutionError(
        'PRICING_CHANGE_PAYLOAD_INCOMPLETE',
        'Approved service-pricing proposal is incomplete.',
      )
    }
    const { data: result, error } = await supabaseAdmin().rpc('apply_service_pricing_change', {
      p_account_id: input.accountId,
      p_change_request_id: row.id,
      p_service_id: p.service_id,
      p_expected_service_version: p.expected_service_version,
      p_expected_current_revision_id: p.expected_current_revision_id,
      p_name: p.name,
      p_kind: p.kind,
      p_fee_currency: p.fee_currency ?? null,
      p_input_currency: p.input_currency ?? null,
      p_minimum_fee: p.minimum_fee ?? null,
      p_maximum_fee: p.maximum_fee ?? null,
      p_rounding_mode: p.rounding_mode ?? null,
      p_formula_config: p.formula_config,
      p_actor_user_id: input.actorUserId,
    })
    if (error || !result) {
      const message = error?.message ?? 'Service pricing change failed.'
      if (message.includes('SERVICE_VERSION_CHANGED') || message.includes('SERVICE_CURRENT_REVISION_CHANGED')) {
        throw new ChangeExecutionError(
          'SERVICE_PRICING_VERSION_CONFLICT',
          'The service changed after this pricing proposal; review and approve a fresh proposal.',
        )
      }
      throw error ?? new ChangeExecutionError('SERVICE_PRICING_CHANGE_FAILED', message)
    }
    const applied = result as { pricing_rule_id?: string; revision_id?: string; idempotent?: boolean }
    return {
      target_type: row.target_type,
      operation: 'create_pricing_rule_and_publish_service_revision',
      service_id: p.service_id,
      pricing_rule_id: applied.pricing_rule_id ?? null,
      revision_id: applied.revision_id ?? null,
      idempotent: applied.idempotent ?? false,
    }
  }

  if (row.target_type === 'pricing_rule' && row.intent === 'publish' && row.target_id) {
    const published = await publishPricingRuleRaw(input.accountId, row.target_id, input.actorUserId)
    return {
      target_type: row.target_type,
      target_id: row.target_id,
      operation: 'publish',
      rule: published,
    }
  }

  if (row.target_type === 'service' && row.intent === 'update' && row.target_id) {
    const p = row.proposed_payload as {
      expected_current_revision_id?: string
      name?: string
      public_description?: string | null
      ai_guidance?: string | null
      field_values?: Record<string, unknown>
      pricing_rule_id?: string | null
      service_status?: string
    }
    if (row.expected_version == null || !p.expected_current_revision_id || !p.name || !p.service_status || !p.field_values) {
      throw new ChangeExecutionError('SERVICE_CHANGE_PAYLOAD_INCOMPLETE', 'Approved service change payload is incomplete.')
    }
    const { data: currentRevision, error: currentError } = await supabaseAdmin()
      .from('service_revisions')
      .select('category_schema_version_id')
      .eq('account_id', input.accountId)
      .eq('service_id', row.target_id)
      .eq('id', p.expected_current_revision_id)
      .maybeSingle()
    if (currentError) throw currentError
    if (!currentRevision) throw new ChangeExecutionError('SERVICE_CURRENT_REVISION_CHANGED', 'The service revision changed after this proposal was created.')
    const { data: defs, error: defsError } = await supabaseAdmin()
      .from('service_field_definitions')
      .select('field_key, label, help_text, data_type, required, visibility, constraints, display_order, is_filterable')
      .eq('account_id', input.accountId)
      .eq('schema_version_id', currentRevision.category_schema_version_id)
    if (defsError) throw defsError
    const checked = validateValues(
      compileFieldSchema((defs ?? []) as FieldDefinitionInput[]),
      p.field_values,
      'full',
    )
    if (!checked.ok || !checked.normalized) {
      throw new ChangeExecutionError('SERVICE_FIELDS_INVALID', 'Approved service fields no longer satisfy the schema.')
    }
    const { data: revisionId, error } = await supabaseAdmin().rpc('apply_service_agent_change', {
      p_account_id: input.accountId,
      p_change_request_id: row.id,
      p_service_id: row.target_id,
      p_expected_version: row.expected_version,
      p_expected_current_revision_id: p.expected_current_revision_id,
      p_name: p.name,
      p_public_description: p.public_description ?? null,
      p_ai_guidance: p.ai_guidance ?? null,
      p_field_values: checked.normalized,
      p_pricing_rule_id: p.pricing_rule_id ?? null,
      p_service_status: p.service_status,
      p_actor_user_id: input.actorUserId,
    })
    if (error || !revisionId) {
      const message = error?.message ?? 'Service change failed.'
      if (message.includes('SERVICE_VERSION_CHANGED') || message.includes('SERVICE_CURRENT_REVISION_CHANGED')) {
        throw new ChangeExecutionError('SERVICE_VERSION_CONFLICT', 'The service changed after this proposal; review a fresh proposal.')
      }
      throw error ?? new ChangeExecutionError('SERVICE_CHANGE_FAILED', message)
    }
    return {
      target_type: row.target_type,
      target_id: row.target_id,
      operation: 'publish_new_revision',
      revision_id: revisionId as string,
    }
  }

  if (row.target_type === 'fx_rate_pair' && row.intent === 'update' && row.target_id) {
    const p = row.proposed_payload as {
      expected_lock_version?: number
      business_buy_rate?: string
      business_sell_rate?: string
      notes_internal?: string | null
    }
    if (
      !Number.isSafeInteger(p.expected_lock_version) ||
      Number(p.expected_lock_version) < 0 ||
      !p.business_buy_rate ||
      !p.business_sell_rate
    ) {
      throw new ChangeExecutionError(
        'FX_RATE_CHANGE_PAYLOAD_INCOMPLETE',
        'Approved FX rate proposal is missing lock version or buy/sell rates.',
      )
    }
    try {
      const published = await publishFxRateVersion({
        accountId: input.accountId,
        pairId: row.target_id,
        expectedLockVersion: Number(p.expected_lock_version),
        businessBuyRate: p.business_buy_rate,
        businessSellRate: p.business_sell_rate,
        source: 'admin_agent',
        sourceChangeRequestId: row.id,
        notesInternal: p.notes_internal ?? null,
        actorUserId: input.actorUserId,
      })
      return {
        target_type: row.target_type,
        target_id: row.target_id,
        operation: 'publish_fx_v2_rate_version',
        version_id: published.versionId,
        version_number: published.versionNumber,
        lock_version: published.lockVersion,
        idempotent: published.idempotent,
      }
    } catch (err) {
      if (err instanceof FxServiceError) {
        throw new ChangeExecutionError(err.code, err.message, err.status)
      }
      throw err
    }
  }

  if (row.target_type === 'fx_trade_request' && row.intent === 'update' && row.target_id) {
    const p = row.proposed_payload as {
      expected_status?: string
      decision?: string
      note?: string | null
      rate_version_id?: string
    }
    if (
      p.expected_status !== 'pending_admin' ||
      (p.decision !== 'approve' && p.decision !== 'reject')
    ) {
      throw new ChangeExecutionError(
        'FX_TRADE_DECISION_PAYLOAD_INCOMPLETE',
        'Approved FX trade decision must target pending_admin and choose approve or reject.',
      )
    }
    try {
      const decided = await decideFxTradeRequest({
        accountId: input.accountId,
        requestId: row.target_id,
        expectedStatus: 'pending_admin',
        decision: p.decision,
        changeRequestId: row.id,
        note: p.note ?? null,
        actorUserId: input.actorUserId,
      })
      return {
        target_type: row.target_type,
        target_id: row.target_id,
        operation: 'decide_fx_v2_trade_request',
        decision: p.decision,
        rate_version_id: p.rate_version_id ?? null,
        request_status: decided.status,
        idempotent: decided.idempotent,
      }
    } catch (err) {
      if (err instanceof FxServiceError) {
        throw new ChangeExecutionError(err.code, err.message, err.status)
      }
      throw err
    }
  }

  if (row.target_type === 'service_intent' && ['create', 'update'].includes(row.intent) && row.target_id) {
    const decision = row.proposed_payload.decision as string | undefined
    const allowed = new Set(['fulfilled', 'rejected', 'matched', 'clarifying'])
    if (!decision || !allowed.has(decision)) {
      throw new ChangeExecutionError('DECISION_REQUIRED', `decision must be one of: ${[...allowed].join(', ')}.`)
    }
    const update: Record<string, unknown> = { status: decision }
    if (decision === 'matched') {
      const serviceId = row.proposed_payload.matched_service_id as string | undefined
      if (!serviceId) throw new ChangeExecutionError('MATCHED_SERVICE_REQUIRED', 'matched_service_id is required when decision=matched.')
      const { data: svc } = await supabaseAdmin()
        .from('services')
        .select('id')
        .eq('account_id', input.accountId)
        .eq('id', serviceId)
        .maybeSingle()
      if (!svc) throw new ChangeExecutionError('SERVICE_NOT_FOUND', 'Matched service not found in this account.', 404)
      update.matched_service_id = serviceId
    }
    const { error } = await supabaseAdmin()
      .from('customer_intents')
      .update(update)
      .eq('account_id', input.accountId)
      .eq('id', row.target_id)
    if (error) throw error
    return {
      target_type: row.target_type,
      target_id: row.target_id,
      operation: 'intent_decision',
      decision,
      customer_notification: {
        intent_id: row.target_id,
        event_type:
          decision === 'rejected'
            ? 'rejected'
            : decision === 'clarifying'
              ? 'needs_clarification'
              : decision === 'matched'
                ? 'matched'
                : 'approved_and_applied',
        message_text:
          decision === 'rejected'
            ? 'تمت مراجعة طلبك من الإدارة ولم يتم اعتماده.'
            : decision === 'clarifying'
              ? 'راجعت الإدارة طلبك وتحتاج إلى معلومات إضافية قبل اتخاذ القرار.'
              : decision === 'matched'
                ? 'تمت مراجعة طلبك وربطه بخدمة متوفرة لدينا.'
                : 'تمت مراجعة طلبك واعتماده من الإدارة.',
      },
    }
  }

  if (
    row.target_type === 'coverage_offer' &&
    row.intent === 'create' &&
    !row.target_id &&
    row.proposed_payload.contact_id
  ) {
    const p = row.proposed_payload as {
      contact_id?: string
      service_id?: string
      total_amount?: string
      currency?: string
      attributes?: Record<string, unknown>
      commission_per_thousand?: string
      commission_currency?: string
      deal_date?: string
      intent_id?: string
    }
    if (!p.service_id || !p.total_amount || !p.currency || !p.contact_id) {
      throw new ChangeExecutionError('OFFER_PAYLOAD_INCOMPLETE', 'Approved payload must carry contact_id, service_id, total_amount, currency.')
    }
    const offerAttrs = readCoverageAttributes(p.attributes ?? {})
    const reference = `CHG-${row.id.slice(0, 8).toUpperCase()}`
    const { data: offer, error: offerError } = await supabaseAdmin()
      .from('coverage_offers')
      .upsert(
        {
          account_id: input.accountId,
          service_id: p.service_id,
          provider_contact_id: p.contact_id,
          reference_code: reference,
          total_amount: p.total_amount,
          currency: p.currency,
          attributes: offerAttrs,
          ...(p.commission_per_thousand ? { commission_per_thousand: p.commission_per_thousand } : {}),
          ...(p.commission_currency ? { commission_currency: p.commission_currency } : {}),
          ...(p.deal_date ? { deal_date: p.deal_date } : {}),
          source_change_request_id: row.id,
          status: 'active',
          created_by: input.actorUserId,
        },
        { onConflict: 'source_change_request_id' },
      )
      .select('id, reference_code')
      .single()
    if (offerError) throw offerError
    if (p.intent_id) {
      const { error: intentError } = await supabaseAdmin()
        .from('customer_intents')
        .update({ status: 'fulfilled', matched_service_id: p.service_id })
        .eq('account_id', input.accountId)
        .eq('id', p.intent_id)
      if (intentError) throw intentError
    }
    return {
      target_type: row.target_type,
      operation: 'create',
      offer,
      ...(p.intent_id
        ? {
            customer_notification: {
              intent_id: p.intent_id,
              event_type: 'approved_and_applied',
              template_event: 'coverage.offer.approved',
              template_payload: {
                kind: 'offer',
                entity_id: offer.id,
                reference: offer.reference_code,
                service_id: p.service_id,
                amount: p.total_amount,
                currency: p.currency,
                attributes: offerAttrs,
                commission_per_thousand: p.commission_per_thousand ?? null,
                commission_currency: p.commission_currency ?? p.currency,
              } satisfies CoverageNotificationPayload,
            },
          }
        : {}),
    }
  }

  if (
    row.target_type === 'coverage_request' &&
    row.intent === 'create' &&
    !row.target_id &&
    row.proposed_payload.contact_id
  ) {
    const p = row.proposed_payload as {
      contact_id?: string
      service_id?: string
      requested_amount?: string
      currency?: string
      attributes?: Record<string, unknown>
      commission_per_thousand?: string
      commission_currency?: string
      deal_date?: string
      expires_at?: string
      intent_id?: string
    }
    if (!p.service_id || !p.requested_amount || !p.currency || !p.contact_id) {
      throw new ChangeExecutionError(
        'REQUEST_PAYLOAD_INCOMPLETE',
        'Approved payload must carry contact_id, service_id, requested_amount, currency.',
      )
    }
    const amount = Number(p.requested_amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ChangeExecutionError('REQUEST_AMOUNT_INVALID', 'requested_amount must be positive.')
    }
    const requestAttrs = readCoverageAttributes(p.attributes ?? {})
    const { data: request, error: requestError } = await supabaseAdmin()
      .from('coverage_requests')
      .upsert(
        {
          account_id: input.accountId,
          service_id: p.service_id,
          requester_contact_id: p.contact_id,
          requested_amount: p.requested_amount,
          currency: p.currency,
          attributes: requestAttrs,
          ...(p.commission_per_thousand ? { commission_per_thousand: p.commission_per_thousand } : {}),
          ...(p.commission_currency ? { commission_currency: p.commission_currency } : {}),
          ...(p.deal_date ? { deal_date: p.deal_date } : {}),
          ...(p.expires_at ? { expires_at: p.expires_at } : {}),
          source_change_request_id: row.id,
          status: 'active',
          created_by: input.actorUserId,
        },
        { onConflict: 'source_change_request_id' },
      )
      .select('id, requested_amount, currency, status')
      .single()
    if (requestError) throw requestError
    if (p.intent_id) {
      const { error: intentError } = await supabaseAdmin()
        .from('customer_intents')
        .update({ status: 'fulfilled', matched_service_id: p.service_id })
        .eq('account_id', input.accountId)
        .eq('id', p.intent_id)
      if (intentError) throw intentError
    }
    return {
      target_type: row.target_type,
      operation: 'create',
      request,
      ...(p.intent_id
        ? {
            customer_notification: {
              intent_id: p.intent_id,
              event_type: 'approved_and_applied',
              template_event: 'coverage.request.approved',
              template_payload: {
                kind: 'request',
                entity_id: request.id,
                reference: null,
                service_id: p.service_id,
                amount: p.requested_amount,
                currency: p.currency,
                attributes: requestAttrs,
                commission_per_thousand: p.commission_per_thousand ?? null,
                commission_currency: p.commission_currency ?? p.currency,
              } satisfies CoverageNotificationPayload,
            },
          }
        : {}),
    }
  }

  throw new ChangeExecutionError(
    'UNSUPPORTED_TARGET',
    `No deterministic executor for ${row.target_type}/${row.intent}.`,
  )
}

async function enqueueCustomerNotification(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  changeRequestId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const notification = result.customer_notification as CustomerNotificationDescriptor | undefined
  if (!notification?.intent_id || !notification.event_type) return

  const { data: intent, error: intentError } = await db
    .from('customer_intents')
    .select('id, contact_id, conversation_id')
    .eq('account_id', accountId)
    .eq('id', notification.intent_id)
    .maybeSingle()
  if (intentError) throw intentError
  if (!intent?.conversation_id || !intent.contact_id) return

  let messageText = notification.message_text ?? null
  if (!messageText && notification.template_event && notification.template_payload) {
    messageText = await renderStructuredCustomerNotification(
      db,
      accountId,
      notification.template_event,
      notification.template_payload,
    )
  }
  if (!messageText) return

  const { error } = await db
    .from('customer_intent_notifications')
    .upsert(
      {
        account_id: accountId,
        intent_id: notification.intent_id,
        change_request_id: changeRequestId,
        contact_id: intent.contact_id,
        conversation_id: intent.conversation_id,
        event_type: notification.event_type,
        message_text: messageText,
        status: 'pending',
      },
      {
        onConflict: 'account_id,intent_id,change_request_id,event_type',
        ignoreDuplicates: true,
      },
    )
  if (error) throw error
}

async function renderStructuredCustomerNotification(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  eventKey: string,
  payload: CoverageNotificationPayload,
): Promise<string> {
  if (eventKey !== 'coverage.offer.approved' && eventKey !== 'coverage.request.approved') {
    return ''
  }

  const regionIds = [payload.attributes.pay_region_id, payload.attributes.receive_region_id].filter(
    (id): id is string => Boolean(id),
  )
  const regionNames = new Map<string, string>()
  if (regionIds.length > 0) {
    const { data: regions, error: regionError } = await db
      .from('coverage_regions')
      .select('id, name, code')
      .eq('account_id', accountId)
      .in('id', [...new Set(regionIds)])
    if (regionError) throw regionError
    for (const region of regions ?? []) {
      regionNames.set(region.id, region.name || region.code || region.id)
    }
  }

  const payRegion =
    (payload.attributes.pay_region_id && regionNames.get(payload.attributes.pay_region_id)) ||
    payload.attributes.coverage_country ||
    'غير محدد'
  const receiveRegion =
    (payload.attributes.receive_region_id && regionNames.get(payload.attributes.receive_region_id)) ||
    payload.attributes.coverage_country ||
    'غير محدد'

  const rendered = await renderCoverageApprovedCustomerMessage({
    accountId,
    kind: payload.kind,
    entityId: payload.entity_id,
    reference: payload.reference,
    serviceId: payload.service_id,
    amount: payload.amount,
    currency: payload.currency,
    payRegion,
    payMethod: payload.attributes.pay_method,
    receiveRegion,
    receiveMethod: payload.attributes.receive_method,
    commissionPerThousand: payload.commission_per_thousand,
    commissionCurrency: payload.commission_currency,
    store: createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      `[messaging] event=${rendered.eventKey}`,
      `source=${rendered.source}`,
      `template=${rendered.eventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  return rendered.text
}

async function assertExpectedVersion(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  row: ClaimedChange,
): Promise<void> {
  if (row.expected_version == null) return
  if (!row.target_id) {
    throw new ChangeExecutionError(
      'EXPECTED_VERSION_WITHOUT_TARGET',
      'expected_version cannot be used without a target row.',
    )
  }

  const versionedTables: Record<string, string> = {
    service: 'services',
    ai_agent: 'ai_agents',
  }
  const table = versionedTables[row.target_type]
  if (!table) {
    throw new ChangeExecutionError(
      'EXPECTED_VERSION_UNSUPPORTED',
      `Target ${row.target_type} does not expose a runtime version check.`,
    )
  }
  const { data, error } = await db
    .from(table)
    .select('version')
    .eq('account_id', accountId)
    .eq('id', row.target_id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ChangeExecutionError('TARGET_NOT_FOUND', 'Change target not found.', 404)
  if (Number((data as { version: number }).version) !== Number(row.expected_version)) {
    throw new ChangeExecutionError('EXPECTED_VERSION_CONFLICT', 'Target changed after this proposal was created.')
  }
}

function mapClaimError(message: string): string {
  const known = [
    'CHANGE_REQUEST_NOT_FOUND',
    'CHANGE_REQUEST_NOT_APPROVED',
    'CHANGE_REQUEST_EXPIRED',
    'CHANGE_REQUEST_CONTENT_CHANGED',
    'CHANGE_REQUEST_EXECUTION_RACE',
  ]
  return known.find((code) => message.includes(code)) ?? 'EXECUTION_CLAIM_FAILED'
}
