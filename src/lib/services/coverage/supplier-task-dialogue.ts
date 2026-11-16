import { describeSupplierCoverageRoute, supplierNotesConflictWithRoute,
  type SupplierCoverageRoute, type SupplierRegionReference } from './supplier-request-route'
/**
 * Coverage sourcing supplier turn protocol. Pure logic; no model can mutate
 * CRM, select recipients, or create an approval based solely on prompt text.
 * Every final submit is separately bound to the run, Task and exact contact.
 */
export type SupplierStage = 'availability' | 'route' | 'amount' | 'commission' | 'details'
  | 'confirmation' | 'submitting' | 'submitted' | 'needs_human' | 'declined'

export interface SupplierTurnState {
  stage: SupplierStage
  offeredAmount: string | null
  commissionPerThousand: string | null
  supplierDetails: string | null
  /** Explicit supplier assent to the *exact* frozen source request legs. */
  routeConfirmed: boolean
}
export interface SupplierTurnStep {
  next: SupplierTurnState
  response: string
  action: 'reply' | 'submit' | 'decline'
}
export interface SupplierRequestFacts {
  remainingAmount: string
  currency: string
  route: SupplierCoverageRoute
  knownRegions: readonly SupplierRegionReference[]
}
const moneyPattern = /^([0-9]{1,12}(?:\.[0-9]{1,4})?)(?:\s*(?:ريال|ر[.]س|SAR|﷼))?$/i

export function normalizeSupplierNumber(text: string): string {
  return text.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
}
export function parseSupplierNumber(raw: string, max: number, allowZero = false): string | null {
  const normalized = normalizeSupplierNumber(raw).trim()
  const matched = moneyPattern.exec(normalized) ??
    /^([0-9]{1,12}(?:\.[0-9]{1,4})?)\s*(?:لكل\s*(?:1000|ألف)|\/\s*1000)$/i.exec(normalized)
  if (!matched) return null
  const value = Number(matched[1])
  if (!Number.isFinite(value) || value > max || (allowZero ? value < 0 : value <= 0)) return null
  return matched[1]
}
export function supplierAffirms(text: string): boolean {
  return /^(نعم|أجل|اجل|ايوه|أيوه|ايوا|تمام|موافق|يمكنني|أستطيع|استطيع|متوفر|متاح|yes|ok|sure)(?:[\s،,.!]|$)/i.test(text.trim())
}
export function supplierDeclines(text: string): boolean {
  return /^(لا|غير متوفر|غير متاح|لا أستطيع|لا استطيع|لا يمكنني|no|unavailable)(?:[\s،,.!]|$)/i.test(text.trim())
}
export function supplierConfirmsRoute(text: string): boolean {
  return /^(المسار مطابق|أوافق على المسار|اوافق على المسار|المسار صحيح|route confirmed)$/i.test(text.trim())
}
export function supplierConfirmsFinal(text: string): boolean {
  return /^(تأكيد|أؤكد|اؤكد|نعم أؤكد|نعم اؤكد|أوافق على التفاصيل|اوافق على التفاصيل|confirm|confirmed)(?:[\s.!،]*$)/i.test(text.trim())
}
const same = (s: SupplierTurnState, response: string): SupplierTurnStep =>
  ({ next: s, response, action: 'reply' })
export function initialSupplierState(): SupplierTurnState {
  return { stage: 'availability', offeredAmount: null, commissionPerThousand: null,
    supplierDetails: null, routeConfirmed: false }
}

/** Ask for a complete, operator-reviewable offer, never infer absent amounts or
 * convert a supplier's negotiated commission to a published customer rate. */
export function advanceSupplierTurn(
  state: SupplierTurnState,
  raw: string,
  facts: SupplierRequestFacts,
): SupplierTurnStep {
  const input = raw.trim()
  if (supplierDeclines(input) && state.stage !== 'route' &&
      state.stage !== 'submitting' && state.stage !== 'submitted') {
    return {
      next: { ...state, stage: 'declined' },
      response: 'شكرًا لتوضيحكم، لن نتابع طلب التغطية معكم حاليًا.',
      action: 'decline',
    }
  }
  switch (state.stage) {
    case 'availability':
      if (!supplierAffirms(input)) {
        return same(state, [
          `هل يمكنكم توفير تغطية للطلب بقيمة ${facts.remainingAmount} ${facts.currency}؟`,
          describeSupplierCoverageRoute(facts.route),
          'أجيبوا بنعم أو لا. يمكنكم رفض الطلب إن كان المسار غير مناسب.',
        ].join('\n'))
      }
      return {
        next: { ...state, stage:'route' },
        response: [
          'شكرًا. قبل أخذ مبلغكم أو عمولتكم، نحتاج تأكيد أنكم قادرون على تنفيذ *نفس* المسار المطلوب:',
          describeSupplierCoverageRoute(facts.route),
          'إذا كانت هذه الجهات وطرق الدفع والاستلام مناسبة، اكتب «المسار مطابق».',
          'إن أردتم التسليم أو الاستلام في موقع مختلف، اكتب «المسار مختلف»؛ لن نرفع عرضًا مخالفًا للإدارة.',
        ].join('\n'),
        action:'reply',
      }
    case 'route':
      if (supplierConfirmsRoute(input)) {
        return {
          next: {...state,routeConfirmed:true,stage:'amount'},
          response:`تم تأكيد مسار الطلب. كم يمكنكم تغطيته فعليًا من أصل ${facts.remainingAmount} ${facts.currency}؟ أرسلوا الرقم فقط.`,
          action:'reply',
        }
      }
      if (/^(المسار مختلف|المسار غير مطابق|غير مطابق|مختلف|لا|غير متوفر)/i.test(input)) {
        return {
          next:{...state,stage:'needs_human'},
          response:'شكرًا للتوضيح. مساركم مختلف عن طلب الإدارة؛ لن نرفع عرضًا على أنه مطابق. ستحتاج الإدارة لمراجعة الاتجاه والشروط معكم أو إنشاء طلب مناسب.',
          action:'reply',
        }
      }
      return same(state, [
        'لم نتلقَّ تأكيدًا صريحًا للمسار المحدد:',
        describeSupplierCoverageRoute(facts.route),
        'اكتب «المسار مطابق» إذا كنت ستلتزم بالاتجاه والطرق المذكورة، أو «المسار مختلف».',
      ].join('\n'))
    case 'amount': {
      const amount = parseSupplierNumber(input, Number(facts.remainingAmount))
      if (!amount) {
        return same(state, `يرجى تحديد مبلغ موجب لا يتجاوز ${facts.remainingAmount} ${facts.currency}، بالأرقام فقط؛ سنرفعه كما تؤكدونه.`)
      }
      const hasCommission = state.commissionPerThousand !== null
      return {
        next: { ...state, offeredAmount: amount, stage: hasCommission ? 'details' : 'commission' },
        response: hasCommission
          ? 'شكرًا. ما وقت جاهزية المبلغ، وأي شروط تشغيلية إضافية؟ المسار والطرق أكدتموها بالفعل، لذلك لا تغيّروا المدن في الملاحظات. اكتبوا التفاصيل في رسالة واحدة.'
          : 'ما العمولة التي تطلبونها لكل 1000 من المبلغ؟ أرسلوا الرقم فقط (مثال: 7)، ويمكن إدخال 0 إذا كانت بلا عمولة.',
        action: 'reply',
      }
    }
    case 'commission': {
      const commission = parseSupplierNumber(input, 1000, true)
      if (commission === null) {
        return same(state, 'يرجى تحديد العمولة لكل 1000 بالأرقام (مثلًا 7 أو 0). لن نفترض عمولة نيابةً عنكم.')
      }
      return {
        next: { ...state, commissionPerThousand: commission, stage: 'details' },
        response: 'شكرًا. ما وقت جاهزية المبلغ، وأي شروط تشغيلية إضافية؟ المسار والطرق أكدتموها بالفعل، لذلك لا تغيّروا المدن في الملاحظات. اكتبوا التفاصيل في رسالة واحدة.',
        action: 'reply',
      }
    }
    case 'details': {
      if (!state.routeConfirmed) {
        return same({...state,stage:'route'}, 'لم يُؤكَّد مسار الطلب بعد؛ اكتب «المسار مطابق» أو «المسار مختلف» قبل تقديم العرض.')
      }
      if (input.length < 12 || input.length > 800 || !state.offeredAmount || state.commissionPerThousand === null) {
        return same(state, 'تفاصيل العرض غير كافية. اذكر موعد الجاهزية والشروط التشغيلية دون تغيير مدن/طرق طلب الإدارة (12–800 حرف).')
      }
      if (supplierNotesConflictWithRoute(input,facts.route,facts.knownRegions)) {
        return {
          next:{...state,stage:'needs_human',supplierDetails:input},
          response:'ورد في تفاصيلكم موقع تسليم أو استلام يحتاج إلى مراجعة مقارنة بمسار الطلب. لن نسجل عرضًا على أنه مطابق قبل التحقق مع الإدارة. احتفظنا بتفاصيلكم للمتابعة البشرية.',
          action:'reply',
        }
      }
      const next = { ...state, stage: 'confirmation' as const, supplierDetails: input }
      return {
        next,
        response: [
          'يرجى مراجعة العرض المرتبط بالطلب الأصلي قبل رفعه للإدارة:',
          `المبلغ المتاح: ${next.offeredAmount} ${facts.currency}`,
          `العمولة المطلوبة: ${next.commissionPerThousand} لكل 1000`,
          describeSupplierCoverageRoute(facts.route),
          `شروطكم الإضافية: ${next.supplierDetails}`,
          'إذا كانت جميع المعلومات مطابقة اكتب «تأكيد». ولتغيير العرض اكتب «تعديل». لا يُعتبر العرض معتمدًا قبل قرار الإدارة.',
        ].join('\n'),
        action:'reply',
      }
    }
    case 'confirmation':
      if (/^(تعديل|edit|تغيير)/i.test(input)) {
        return { next: initialSupplierState(), response: 'حسنًا، سنبدأ مراجعة العرض من جديد مع التأكد من مطابقة مسار طلب الإدارة أولًا.', action: 'reply' }
      }
      if (!supplierConfirmsFinal(input)) {
        return same(state, 'لرفع تفاصيل العرض للإدارة، اكتب «تأكيد» بعد مراجعة الملخص، أو «تعديل» لتصحيحه.')
      }
      if (!state.routeConfirmed || !state.offeredAmount || state.commissionPerThousand === null || !state.supplierDetails) {
        return same(state, 'بيانات العرض أو تأكيد المسار غير مكتملة؛ لا يمكن تقديمه للإدارة. اكتب «تعديل» لإعادة إدخالها.')
      }
      if (supplierNotesConflictWithRoute(state.supplierDetails,facts.route,facts.knownRegions)) {
        return {
          next:{...state,stage:'needs_human'},
          response:'الشروط التي ذكرتموها تحتاج مراجعة المواقع مقارنة بطلب الإدارة. لم يُرفع أي عرض تلقائيًا.',
          action:'reply',
        }
      }
      return {
        next: { ...state, stage: 'submitting' },
        response: 'جارٍ تسجيل العرض للمراجعة.',
        action: 'submit',
      }
    case 'submitting':
      return same(state, 'عرض التغطية قيد التسجيل. سنؤكد رقم الطلب عند توفره، ولا نرسل طلبًا مكررًا.')
    case 'submitted':
      return same(state, 'تم رفع تفاصيل عرض التغطية للإدارة سابقًا. سيُتواصل معك بعد المراجعة، ولا يعني ذلك الاعتماد النهائي.')
    case 'needs_human':
      return same(state, 'تعذر تسجيل العرض إداريًا، وقد أحلناه للمتابعة البشرية. لن نخبرك أنه اعتُمد دون تأكيد.')
    case 'declined':
      return same(state, 'شكرًا لتواصلك. تم تسجيل تعذر توفير التغطية لهذا الطلب.')
  }
}
