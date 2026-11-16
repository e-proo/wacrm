/**
 * Coverage sourcing supplier turn protocol. Pure logic; no model can mutate
 * CRM, select recipients, or create an approval based solely on prompt text.
 * Every final submit is separately bound to the run, Task and exact contact.
 */
export type SupplierStage = 'availability' | 'amount' | 'commission' | 'details'
  | 'confirmation' | 'submitting' | 'submitted' | 'needs_human' | 'declined'

export interface SupplierTurnState {
  stage: SupplierStage
  offeredAmount: string | null
  commissionPerThousand: string | null
  supplierDetails: string | null
}
export interface SupplierTurnStep {
  next: SupplierTurnState
  response: string
  action: 'reply' | 'submit' | 'decline'
}
export interface SupplierRequestFacts {
  remainingAmount: string
  currency: string
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
export function supplierConfirmsFinal(text: string): boolean {
  return /^(تأكيد|أؤكد|اؤكد|نعم أؤكد|نعم اؤكد|أوافق على التفاصيل|اوافق على التفاصيل|confirm|confirmed)(?:[\s.!،]*$)/i.test(text.trim())
}
const same = (s: SupplierTurnState, response: string): SupplierTurnStep =>
  ({ next: s, response, action: 'reply' })
export function initialSupplierState(): SupplierTurnState {
  return { stage: 'availability', offeredAmount: null, commissionPerThousand: null,
    supplierDetails: null }
}

/** Ask for a complete, operator-reviewable offer, never infer absent amounts or
 * convert a supplier's negotiated commission to a published customer rate. */
export function advanceSupplierTurn(
  state: SupplierTurnState,
  raw: string,
  facts: SupplierRequestFacts,
): SupplierTurnStep {
  const input = raw.trim()
  if (supplierDeclines(input) && state.stage !== 'submitting' && state.stage !== 'submitted') {
    return {
      next: { ...state, stage: 'declined' },
      response: 'شكرًا لتوضيحكم، لن نتابع طلب التغطية معكم حاليًا.',
      action: 'decline',
    }
  }
  switch (state.stage) {
    case 'availability':
      if (!supplierAffirms(input)) {
        return same(state, `هل يمكنكم توفير تغطية للطلب بقيمة ${facts.remainingAmount} ${facts.currency}؟ أجيبوا بنعم أو لا.`)
      }
      return {
        next: { ...state, stage: 'amount' },
        response: `شكرًا، ما المبلغ المتاح فعليًا للتغطية من أصل ${facts.remainingAmount} ${facts.currency}؟ أرسلوا الرقم فقط (مثلًا ${facts.remainingAmount}).`,
        action: 'reply',
      }
    case 'amount': {
      const amount = parseSupplierNumber(input, Number(facts.remainingAmount))
      if (!amount) {
        return same(state, `يرجى تحديد مبلغ موجب لا يتجاوز ${facts.remainingAmount} ${facts.currency}، بالأرقام فقط؛ سنرفعه كما تؤكدونه.`)
      }
      const hasCommission = state.commissionPerThousand !== null
      return {
        next: { ...state, offeredAmount: amount, stage: hasCommission ? 'details' : 'commission' },
        response: hasCommission
          ? 'شكرًا. نحتاج الآن تفاصيل التغطية: موقع/مدينة التسليم والاستلام، طريقة الدفع والاستلام، وقت الجاهزية، وأي شروط مهمة. اكتب التفاصيل في رسالة واحدة.'
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
        response: 'شكرًا. نحتاج تفاصيل التغطية: موقع/مدينة التسليم والاستلام، طريقة الدفع والاستلام، وقت الجاهزية، وأي شروط مهمة. اكتب التفاصيل في رسالة واحدة.',
        action: 'reply',
      }
    }
    case 'details': {
      if (input.length < 12 || input.length > 800 || !state.offeredAmount || state.commissionPerThousand === null) {
        return same(state, 'تفاصيل العرض غير كافية. وضّح المكان وطريقة التسليم والاستلام وموعد التوفر وأي شروط، في رسالة واحدة (12–800 حرف).')
      }
      const next = { ...state, stage: 'confirmation' as const, supplierDetails: input }
      return {
        next,
        response: `يرجى مراجعة تفاصيل عرضك قبل رفعه للإدارة:\nالمبلغ: ${next.offeredAmount} ${facts.currency}\nالعمولة المطلوبة: ${next.commissionPerThousand} لكل 1000\nالتفاصيل: ${next.supplierDetails}\n\nإذا كانت صحيحة اكتب «تأكيد». لتعديل البيانات اكتب «تعديل». لن يعتبر العرض معتمدًا حتى تراجعه الإدارة.`,
        action: 'reply',
      }
    }
    case 'confirmation':
      if (/^(تعديل|edit|تغيير)/i.test(input)) {
        return { next: initialSupplierState(), response: 'حسنًا. سنبدأ تصحيح العرض. هل يمكنك توفير التغطية؟', action: 'reply' }
      }
      if (!supplierConfirmsFinal(input)) {
        return same(state, 'لرفع تفاصيل العرض للإدارة، اكتب «تأكيد» بعد مراجعة الملخص، أو «تعديل» لتصحيحه.')
      }
      if (!state.offeredAmount || state.commissionPerThousand === null || !state.supplierDetails) {
        return same(state, 'بيانات العرض غير مكتملة، لا يمكن تقديمه للإدارة. اكتب «تعديل» لإعادة إدخالها.')
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
