import '@supabase/supabase-js'

/**
 * Keep ReturnType<typeof createClient> usable for legacy ungenerated-schema
 * server clients. Supabase's generic createClient signature otherwise reduces
 * table mutation/query payloads to `never` when captured through ReturnType.
 *
 * This overload does not change runtime behavior or authorization; it only
 * preserves the existing untyped service-role client convention until the
 * project adopts generated Database types consistently.
 */
declare module '@supabase/supabase-js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createClient(url: string, key: string, options?: any): any
}
