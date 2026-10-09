import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/account'
import { FxServiceError } from './service'

export function toFxApiError(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof FxServiceError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    )
  }

  console.error('[FX V2 API] uncategorized error:', err)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}
