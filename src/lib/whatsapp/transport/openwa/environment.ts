/** TEST is pinned to exactly one Supabase project; never substring match hostnames. */
export function isOpenWATestProject(url = process.env.NEXT_PUBLIC_SUPABASE_URL): boolean {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'pqirsnfupofhulmewakq.supabase.co' &&
      (parsed.port === '' || parsed.port === '443')
  } catch {
    return false
  }
}
