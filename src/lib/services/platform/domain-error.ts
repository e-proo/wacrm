export class DomainError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = status
  }
}


export interface DomainErrorDescriptor {
  code: string
  message: string
  status: number
}

export function describeDomainError(
  error: unknown,
  fallback: DomainErrorDescriptor,
): DomainErrorDescriptor {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    }
  }
  return fallback
}
