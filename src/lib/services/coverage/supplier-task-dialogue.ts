import { describeSupplierCoverageRoute, type SupplierCoverageRoute,
  type SupplierRegionReference } from './supplier-request-route'
import { extractSupplierQuote } from './supplier-quote-extraction'

export type SupplierStage = 'availability' | 'route' | 'amount' | 'commission' | 'details'
  | 'confirmation' | 'submitting' | 'submitted' | 'needs_human' | 'declined'

export interface SupplierTurnState {
  stage: SupplierStage
  offeredAmount: string | null
  commissionPerThousand: string | null
  supplierDetails: string | null
  routeConfirmed: boolean
  routeDifferent: boolean
}
export interface SupplierRequestFacts {
  remainingAmount: string
  currency: string
  route: SupplierCoverageRoute
  knownRegions: readonly SupplierRegionReference[]
}
export interface SupplierTurnStep {
  next: SupplierTurnState
  response: string
  action: 'reply' | 'submit' | 'decline'
}

export function normalizeSupplierNumber(text: string): string {
  return text.replace(/[٠-٩]/g, d => String(d.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0)-0x6f0)).replace(/٫/g,'.')
}
export function parseSupplierNumber(raw: string, max: number, allowZero=false): string | null {
  const t=normalizeSupplierNumber(raw).trim()
  const m=/^(\d{1,12}(?:\.\d{1,4})?)(?:\s*(?:ريال|ر[.]س|SAR|﷼))?$/i.exec(t) ??
    /^(\d{1,12}(?:\.\d{1,4})?)\s*(?:لكل\s*(?:1000|ألف)|\/\s*1000)$/i.exec(t)
  if (!m) return null
  const n=Number(m[1])
  return Number.isFinite(n) && n<=max && (allowZero?n>=0:n>0) ? m[1] : null
}
export function supplierAffirms(text: string): boolean {
  return /^(نعم|أجل|اجل|ايوه|أيوه|ايوا|تمام|موافق|يمكنني|أستطيع|استطيع|متوفر|متاح|yes|ok|sure)(?:[\s،,.!]|$)/i.test(text.trim())
}
export function supplierDeclines(text: string): boolean {
  return /^(?:لا(?:[.!،\s]*)$|غير\s+(?:متوفر|متاح)(?:[.!،\s]|$)|لا\s+(?:أستطيع|استطيع|يمكنني|أقدر|اقدر)(?:\s|$)|no(?:\s|$)|unavailable(?:\s|$))/i.test(text.trim()) &&
    !/المسار\s*(?:مختلف|غير\s*مطابق)/.test(text)
}
export function supplierConfirmsRoute(text: string): boolean {
  return /^(?:(?:نعم|أجل|اجل|ايوه|أيوه|تمام)\s*(?:و)?\s*)?(?:المسار\s*(?:مطابق|صحيح)|(?:أوافق|اوافق)\s+على\s+المسار)(?:[\s.!،]*)$/i.test(text.trim())
}
export function supplierConfirmsFinal(text: string): boolean {
  return /^(?:تأكيد|أؤكد|اؤكد|نعم\s+(?:أؤكد|اؤكد)|أوافق\s+على\s+التفاصيل|اوافق\s+على\s+التفاصيل|confirm|confirmed)(?:[\s.!،]*)$/i.test(text.trim())
}
export function initialSupplierState(): SupplierTurnState {
  return {stage:'availability',offeredAmount:null,commissionPerThousand:null,
    supplierDetails:null,routeConfirmed:false,routeDifferent:false}
}
function same(next:SupplierTurnState,response:string):SupplierTurnStep {
  return {next,response,action:'reply'}
}
function supplierSummary(s:SupplierTurnState,f:SupplierRequestFacts):string {
  const status=s.routeDifferent?'⚠️ عرض بديل: اتجاه أو شروط المورد تختلف عن الطلب، ستراجعها الإدارة فقط.'
    :'المسار المطلوب: مطابق للشروط التي أعلنها النظام.'
  return [
    `المبلغ المتاح: ${s.offeredAmount} ${f.currency}`,
    `العمولة: ${s.commissionPerThousand} لكل 1000`,
    status,describeSupplierCoverageRoute(f.route),
    `تصريح المورد: ${s.supplierDetails ?? 'لم يذكر شروطًا إضافية.'}`,
  ].join('\n')
}
function needsMore(s:SupplierTurnState,f:SupplierRequestFacts):string {
  const missing:string[]=[]
  if (!s.routeConfirmed && !s.routeDifferent) missing.push('هل تتفق مع مسار الطلب المذكور، أم لديك مسار مختلف؟')
  if (!s.offeredAmount) missing.push(`كم المبلغ المتاح للتغطية من أصل ${f.remainingAmount} ${f.currency}؟`)
  if (s.commissionPerThousand === null) missing.push('وما العمولة المطلوبة لكل 1000 (حتى لو كانت صفرًا)؟')
  if (s.routeDifferent && !/(?:في\s+[\p{L}]{2,}|بدل\s+[\p{L}]{2,})/u.test(s.supplierDetails ?? '')) {
    missing.push('وضح جهة التسليم والاستلام المختلفة لننقلها للإدارة.')
  }
  if (!missing.length) return 'هل تؤكد رفع هذه التفاصيل للإدارة؟ اكتب «تأكيد» أو «تعديل».'
  return missing.join('\n')
}

/** Combine any fields already volunteered by the supplier, irrespective of
 * the current stage. No regex extraction is allowed to change CRM route IDs,
 * choose recipients, or approve a proposal. Questions ask only for missing
 * substantive terms, rather than replaying a step-by-step questionnaire.
 */
export function advanceSupplierTurn(state:SupplierTurnState,raw:string,facts:SupplierRequestFacts):SupplierTurnStep {
  const input=raw.trim()
  if (['submitting','submitted','needs_human','declined'].includes(state.stage)) {
    const replies:Record<string,string>={
      submitting:'تم تسجيل بياناتك، نتحقق من رقم العرض ولن نكرر تقديمه.',
      submitted:'عرضك أُحيل للإدارة بالفعل. سنبلغك بقرارها عند صدوره.',
      needs_human:'تفاصيلك قيد مراجعة الإدارة؛ لن نعتمد مسارًا مختلفًا دون قرارها.',
      declined:'شكرًا لتواصلك. تم تسجيل اعتذارك عن الطلب.',
    }
    return same(state,replies[state.stage])
  }
  if (/^(?:تعديل|edit|تغيير)(?:\s|$)/i.test(input)) {
    return same(initialSupplierState(),'ممتاز، ما المبلغ الذي يمكنك تغطيته، وعمولتك لكل 1000، وأي اختلاف في جهة التسليم أو الاستلام؟')
  }
  if (supplierDeclines(input)) return {
    next:{...state,stage:'declined'},
    response:'شكرًا لك، سجلنا عدم توفر التغطية لديك.',
    action:'decline',
  }
  const parsed=extractSupplierQuote(input,facts)
  const routeDifferent=state.routeDifferent || parsed.routeDifference
  const routeConfirmed=!routeDifferent && (
    state.routeConfirmed || supplierConfirmsRoute(input) || parsed.routeAssent
  )
  // A bare number in the commission stage belongs to the per-1000 rate,
  // never silently replaces an amount that the supplier already supplied.
  const isBareNumber=/^\d{1,12}(?:\.\d{1,4})?$/.test(input)
  const offeredAmount=state.stage==='commission' && isBareNumber
    ? state.offeredAmount
    : (parsed.amount ?? parseSupplierNumber(input,Number(facts.remainingAmount)) ??
      state.offeredAmount)
  const commission=parsed.commission ?? (state.stage==='commission'
    ? parseSupplierNumber(input,1000,true) : null) ?? state.commissionPerThousand
  const hadAvailability=state.stage!=='availability'
  if (!hadAvailability && !parsed.available && !parsed.routeDifference && !supplierConfirmsRoute(input) &&
    !parsed.amount && parsed.commission===null) {
    return same(state,`هل تستطيع تغطية ${facts.remainingAmount} ${facts.currency} وفق المسار المعلن؟ اذكر المبلغ والعمولة، وأي تغيير تريده.`)
  }
  // Keep supplier-authored terms verbatim (bounded). Short numeric followups
  // never overwrite a longer, previously signed original quote.
  const substantive=parsed.details && (
    parsed.routeDifference || parsed.available || /(?:طريق|جاهز|حوال|استلم|اسلم|سلم|دفع|مبلغ|عمول|شرط|بدل|تسليم)/.test(input)
  )
  const supplierDetails=substantive
    ? (state.supplierDetails && state.supplierDetails!==parsed.details
        ? [state.supplierDetails,parsed.details].join(' | ').slice(0,800)
        : parsed.details)
    : state.supplierDetails
  let next:SupplierTurnState={
    ...state,routeDifferent,routeConfirmed,offeredAmount,
    commissionPerThousand:commission,supplierDetails,
    stage:state.stage,
  }
  const ready=Boolean(offeredAmount && commission!==null && (routeConfirmed||routeDifferent) &&
    (!routeDifferent || /(?:في\s+[\p{L}]{2,}|بدل\s+[\p{L}]{2,})/u.test(supplierDetails??'')))
  if (!ready) {
    next={...next,stage:!routeConfirmed&&!routeDifferent?'route':
      !offeredAmount?'amount':commission===null?'commission':'details'}
    return same(next,needsMore(next,facts))
  }
  if (!next.supplierDetails) next={...next,supplierDetails:'لم يذكر المورد شروطًا إضافية.'}
  if (state.stage==='confirmation' &&
      !supplierConfirmsFinal(input) && !parsed.finalConsent) {
    return same({...next,stage:'confirmation'},
      'لتقديم العرض، اكتب «تأكيد» أو «تعديل».')
  }
  // One complete explicit acceptance of the advertised request IS an offer:
  // do not demand another keyword, and honor "أكد على العرض" in the same
  // first message. For an unqualified quote with no affirmative, show one
  // compact confirmation summary to avoid proposing without authorization.
  const consent=supplierConfirmsFinal(input)||parsed.finalConsent||parsed.available ||
    (state.stage!=='availability' && (state.routeConfirmed||state.routeDifferent))
  if (!consent) return same({...next,stage:'confirmation'},
    supplierSummary(next,facts)+'\nهل نعتمد هذه التفاصيل للعرض على الإدارة؟ اكتب «تأكيد» أو «تعديل».')
  return {next:{...next,stage:'submitting'},response:'تم استلام عرضك للمراجعة.',action:'submit'}
}
