import { describe, expect, it } from 'vitest'
import { isSensitiveOpenWAAdminApprovalText, isSensitiveOpenWAAdminOwnSentEcho } from './admin-approval-echo'

const approval = [
  '🔔 *طلب اعتماد جديد*',
  'المرجع: CHG-29',
  'النوع: عرض تغطية',
  'الملخص: 400 SAR وعمولة 7 لكل ألف',
  '',
  'للاعتماد: اعتماد CHG-29 1234',
  'للرفض: رفض CHG-29',
].join('\n')

describe('OpenWA trusted-admin approval OTP own-device echo exclusion', () => {
  it('recognizes only the reviewed system template with matching reference and PIN', () => {
    expect(isSensitiveOpenWAAdminApprovalText(approval)).toBe(true)
    expect(isSensitiveOpenWAAdminApprovalText(approval.replace('للرفض: رفض CHG-29','للرفض: رفض CHG-30'))).toBe(false)
    expect(isSensitiveOpenWAAdminApprovalText(approval.replace('المرجع: CHG-29','المرجع: CHG-30'))).toBe(false)
    expect(isSensitiveOpenWAAdminApprovalText(approval.replace('1234','0000'))).toBe(false)
    expect(isSensitiveOpenWAAdminApprovalText('مراجعة CHG-29 دون أي رمز')).toBe(false)
    expect(isSensitiveOpenWAAdminApprovalText(null)).toBe(false)
  })
  it('excludes only verified OpenWA own-sent text, not inbound messages or media', () => {
    const msg = { provider:'openwa', type:'text', text:{body:approval} }
    expect(isSensitiveOpenWAAdminOwnSentEcho(msg as never)).toBe(true)
    expect(isSensitiveOpenWAAdminOwnSentEcho({...msg,provider:'meta_cloud'} as never)).toBe(false)
    expect(isSensitiveOpenWAAdminOwnSentEcho({...msg,type:'image'} as never)).toBe(false)
    expect(isSensitiveOpenWAAdminOwnSentEcho({...msg,text:{body:'Other message'}} as never)).toBe(false)
  })
})
