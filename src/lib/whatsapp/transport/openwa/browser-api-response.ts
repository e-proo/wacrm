/** Browser-side WACRM API response validation (never the OpenWA gateway API).
 * Next.js can return an HTML 404 for a missing local route. Do not expose
 * HTML in a toast or pretend the provider rejected a request.
 */
export async function parseOpenWAApiResponse<T extends Record<string, unknown>>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('json')) {
    if (response.status === 404) {
      throw new Error('WACRM OpenWA API route not found (HTTP 404). Verify the local Git branch and restart the Next.js server.')
    }
    throw new Error(`WACRM OpenWA API returned an unexpected response (HTTP ${response.status}). Check server logs.`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(`WACRM OpenWA API returned invalid JSON (HTTP ${response.status}). Check server logs.`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`WACRM OpenWA API returned an invalid JSON payload (HTTP ${response.status}).`)
  }
  return data as T
}
