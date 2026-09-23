import { describe, expect, it } from 'vitest'
import { ServiceError } from '@/lib/services/domain-services'
import { FxServiceError } from '@/lib/services/fx-v2/service'
import { DomainChangeExecutionError } from './change-executor-registry'
import { DomainError } from './domain-error'

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
