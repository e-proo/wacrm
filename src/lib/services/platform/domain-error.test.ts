import { describe, expect, it } from 'vitest'
import { ServiceError } from '@/lib/services/domain-services'
import { FxServiceError } from '@/lib/services/fx-v2/service'
import {
  DomainChangeExecutionError,
  mapDomainErrorToChangeExecution,
} from './change-executor-registry'
import { DomainError, describeDomainError } from './domain-error'
import { PricingError } from '@/lib/services/pricing/engine'

describe('shared domain error primitive', () => {
  it('preserves domain-specific names, codes, messages, and default statuses', () => {
    const service = new ServiceError('SERVICE_CODE', 'service failed')
    const fx = new FxServiceError('FX_CODE', 'fx failed')
    const change = new DomainChangeExecutionError('CHANGE_CODE', 'change failed')

    expect(service).toBeInstanceOf(DomainError)
    expect(service).toMatchObject({
      name: 'ServiceError',
      code: 'SERVICE_CODE',
      message: 'service failed',
      status: 400,
    })

    expect(fx).toBeInstanceOf(DomainError)
    expect(fx).toMatchObject({
      name: 'FxServiceError',
      code: 'FX_CODE',
      message: 'fx failed',
      status: 400,
    })

    expect(change).toBeInstanceOf(DomainError)
    expect(change).toMatchObject({
      name: 'DomainChangeExecutionError',
      code: 'CHANGE_CODE',
      message: 'change failed',
      status: 409,
    })
  })
})


describe('domain error boundary mapping', () => {
  it('describes only trusted DomainError instances and uses safe fallbacks otherwise', () => {
    expect(
      describeDomainError(new PricingError('INVALID_RULE', 'bad rule'), {
        code: 'FALLBACK',
        message: 'safe fallback',
        status: 500,
      }),
    ).toEqual({
      code: 'INVALID_RULE',
      message: 'bad rule',
      status: 400,
    })

    expect(
      describeDomainError(new Error('database secret'), {
        code: 'FALLBACK',
        message: 'safe fallback',
        status: 500,
      }),
    ).toEqual({
      code: 'FALLBACK',
      message: 'safe fallback',
      status: 500,
    })
  })

  it('maps any DomainError into the deterministic change-execution boundary', () => {
    const mapped = mapDomainErrorToChangeExecution(
      new ServiceError('INVALID_STATE', 'not allowed', 409),
    )
    expect(mapped).toBeInstanceOf(DomainChangeExecutionError)
    expect(mapped).toMatchObject({
      code: 'INVALID_STATE',
      message: 'not allowed',
      status: 409,
    })
    expect(mapDomainErrorToChangeExecution(new Error('boom'))).toBeNull()
  })
})
