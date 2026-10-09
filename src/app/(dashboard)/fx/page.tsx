'use client'

import { useLocale } from 'next-intl'
import { CircleDollarSign } from 'lucide-react'
import { FxDashboard } from '@/components/fx/fx-dashboard'

export default function FxPage() {
  const locale = useLocale()
  const isArabic = locale.startsWith('ar')
  const isKorean = locale.startsWith('ko')
  const title = isArabic ? 'إدارة الصرف' : isKorean ? 'FX 관리' : 'FX Management'
  const description = isArabic
    ? 'إدارة أزواج العملات والأسعار وطلبات الصرف من مصدر مالي واحد.'
    : isKorean
      ? '통화 쌍, 환율, 환전 요청을 하나의 결정적 금융 소스에서 관리합니다.'
      : 'Manage currency pairs, rates, and trade requests from one deterministic financial source.'

  return (
    <div>
      <div className="flex items-center gap-2">
        <CircleDollarSign className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6">
        <FxDashboard />
      </div>
    </div>
  )
}
