import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Public defaults, so a deployment works without env vars being configured first.
// Both values are designed to be public: the project URL is not a secret, and the
// publishable key is restricted by RLS to SELECT on `creators`. Env vars still win,
// so pointing the app at a different project needs no code change.
const DEFAULT_URL = 'https://akqhuzgekjsvrizysfmp.supabase.co'
const DEFAULT_ANON_KEY = 'sb_publishable_ZqxJZMUFFB1LQmcpV92b5w_66qDwpiZ'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_URL
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || DEFAULT_ANON_KEY
const serviceKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string | undefined
const syncSecret = import.meta.env.VITE_SYNC_SECRET as string | undefined

/** Why config is missing, or null when it is fine. Surfaced by <ConfigError/>. */
export const configError: string | null = (() => {
  if (!url) return 'VITE_SUPABASE_URL is not set.'
  if (!anonKey) return 'VITE_SUPABASE_ANON_KEY is not set.'
  try {
    new URL(url)
  } catch {
    return `VITE_SUPABASE_URL is not a valid URL: ${url}`
  }
  return null
})()

const noAuth = { auth: { persistSession: false, autoRefreshToken: false } }

/**
 * Read client. Uses the publishable/anon key, which RLS restricts to SELECT on
 * `creators`. Safe to ship inside the app bundle.
 *
 * A single shared instance -- creating clients per component leaks connections
 * and re-runs auth setup on every render.
 */
export const supabase: SupabaseClient = createClient(url ?? 'http://invalid.local', anonKey ?? 'missing', noAuth)

/**
 * Write client, used only by the upload path. The service role key bypasses RLS,
 * so this is null unless the key is configured -- letting the app run read-only
 * rather than failing at startup.
 */
export const supabaseAdmin: SupabaseClient | null =
  url && serviceKey ? createClient(url, serviceKey, noAuth) : null

export const canWrite = supabaseAdmin !== null

/** Turns a Supabase/network failure into something worth showing a user. */
export function describeError(err: unknown): string {
  if (!err) return 'Unknown error.'
  if (typeof err === 'string') return err
  const e = err as { message?: string; details?: string; hint?: string; code?: string }
  if (e.code === '42501') {
    return 'Permission denied by the database. The key in use lacks access to this table.'
  }
  if (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError')) {
    return 'Could not reach Supabase. Check your network connection and the project URL.'
  }
  return [e.message, e.details, e.hint].filter(Boolean).join(' — ') || 'Unknown error.'
}


/**
 * Pulls the Google Sheet into the database on demand via the sync-sheet Edge
 * Function. A pg_cron job runs the same sync every 15 minutes and the sheet's Apps
 * Script trigger fires it on edit, so this is only for "I changed it just now".
 */
export const canSync = Boolean(url && syncSecret)

export interface SyncResult {
  status: string
  rows_upserted?: number
  rows_deleted?: number
  duration_ms?: number
  error?: string
}

export async function runSheetSync(): Promise<SyncResult> {
  if (!url || !syncSecret) {
    throw new Error('Set VITE_SYNC_SECRET to enable Sync now.')
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/functions/v1/sync-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
    body: JSON.stringify({ trigger: 'app-button' }),
  })
  const body = (await res.json().catch(() => ({}))) as SyncResult
  if (!res.ok) throw new Error(body.error ?? `Sync failed (HTTP ${res.status})`)
  return body
}


/** A Google Sheet connected for continuous syncing. */
export interface SheetSource {
  brand: string
  sheet_id: string
  sheet_url: string
  enabled: boolean
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  last_rows: number | null
}

export async function fetchSheetSources(): Promise<SheetSource[]> {
  const { data, error } = await supabase
    .from('sheet_sources')
    .select('brand,sheet_id,sheet_url,enabled,last_run_at,last_status,last_error,last_rows')
    .order('brand')
  if (error) throw new Error(describeError(error))
  return (data ?? []) as SheetSource[]
}

export interface RegisterResult {
  status: string
  registered?: string
  first_sync?: { status: string; rows_upserted?: number; error?: string }
  error?: string
}

/**
 * Connects a Google Sheet so it syncs every minute from now on.
 *
 * The Edge Function validates the sheet is readable before storing it, so a typo or a
 * sheet that was never link-shared fails here with a usable message rather than being
 * accepted and then silently never syncing.
 */
export async function registerSheet(sheetUrl: string, brand: string): Promise<RegisterResult> {
  if (!url || !syncSecret) {
    throw new Error('Connecting a sheet needs VITE_SYNC_SECRET. See DEPLOY.md.')
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/functions/v1/sync-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
    body: JSON.stringify({ action: 'register', sheetUrl, newBrand: brand }),
  })
  const body = (await res.json().catch(() => ({}))) as RegisterResult
  if (!res.ok) throw new Error(body.error ?? `Could not connect the sheet (HTTP ${res.status})`)
  return body
}


export interface NewCreator {
  channel_link: string
  brand: string
  mail?: string
  category?: string
  country?: string
  language?: string
  audience?: string
  commercials?: string
  deliverables?: string
  platform?: string
}

export interface AddCreatorResult {
  status: string
  creator?: {
    channel_link: string
    brand: string
    platform: string | null
    followers: number | null
    subscribers: number | null
    fee_usd: number | null
    quoted: string | null
  }
  error?: string
}

/**
 * Adds one creator by hand.
 *
 * Goes through the Edge Function rather than writing directly, so the service role
 * key never has to ship in the browser bundle. The function applies exactly the same
 * cleaning a sheet row gets -- "INR 25k" typed here lands the same as "INR 25k" in a
 * cell -- and flags the row so a sheet sync can never delete it.
 */
export async function addCreator(creator: NewCreator): Promise<AddCreatorResult> {
  if (!url || !syncSecret) {
    throw new Error('Adding a creator needs VITE_SYNC_SECRET. See DEPLOY.md.')
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/functions/v1/sync-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
    body: JSON.stringify({ action: 'add_creator', creator }),
  })
  const body = (await res.json().catch(() => ({}))) as AddCreatorResult
  if (!res.ok) throw new Error(body.error ?? `Could not add the creator (HTTP ${res.status})`)
  return body
}
