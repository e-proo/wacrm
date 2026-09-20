import type { PlatformToolErrorContract } from '@/lib/ai/tools/platform/contracts'

export const STANDARD_PLATFORM_TOOL_ERRORS: readonly PlatformToolErrorContract[] = [
  {
    code: 'INVALID_INPUT',
    safeToShow: true,
    meaning: 'Arguments failed the tool schema or business validation.',
  },
  {
    code: 'FORBIDDEN',
    safeToShow: false,
    meaning: 'Runtime plane/capability/grant policy denied the invocation.',
  },
  {
    code: 'NOT_FOUND',
    safeToShow: true,
    meaning: 'The requested account-scoped resource was not found.',
  },
  {
    code: 'INTERNAL_ERROR',
    safeToShow: false,
    meaning: 'The operation failed without exposing internal details.',
  },
]
