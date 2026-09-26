export const SERVICE_REVISION_CONFLICT_MARKERS = [
  'SERVICE_VERSION_CHANGED',
  'SERVICE_CURRENT_REVISION_CHANGED',
] as const

export function getErrorMessage(
  error: unknown,
  fallback = 'Operation failed.',
): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return fallback
}

export function errorHasAnyMarker(
  error: unknown,
  markers: readonly string[],
): boolean {
  const message = getErrorMessage(error, '')
  return markers.some((marker) => message.includes(marker))
}
