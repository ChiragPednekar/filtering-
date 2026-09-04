/**
 * sync-sheet — pulls every connected Google Sheet into `creators`.
 *
 * Sheets are registered in `sheet_sources`, one row per brand. Each run syncs all of
 * them (or just one, if the caller names a brand).
 *
 * Triggered three ways, all hitting this one function:
 *   1. A Google Apps Script onChange trigger in a sheet -> near-instant
 *   2. pg_cron every minute                            -> the normal path
 *   3. "Sync now" / "Connect sheet" in the app          -> on demand
 *
 * Deletions mirror the sheet, scoped to one brand: a creator removed from a synced tab
 * is removed here, but syncing brand A never prunes brand B — which matters because
 * two brands' workbooks routinely share tab names like "Sheet2".
 *
 * Auth: requires the SYNC_SECRET header, or the token the database issued itself. The
 * public URL cannot be used to trigger expensive syncs or to probe the database.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { readWorkbook } from './sheet.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SYNC_SECRET = Deno.env.get('SYNC_SECRET') ?? ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-sync-secret, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })

interface Source {
  brand: string
  sheet_id: string
}

interface Fx {
  usdPerUnit: Record<string, number>
  asOf: string | null
}

/** The file id out of any Google Sheets URL, or null if it isn't one. */
export function sheetIdFromUrl(input: string): string | null {
  const text = (input ?? '').trim()
  if (!text) return null
  // Accept a bare id as well as a full URL.
  if (/^[A-Za-z0-9_-]{25,}$/.test(text)) return text
  const m = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{25,})/)
  return m ? m[1] : null
}

/** Fetch, clean and load one connected sheet. Never throws: failures are reported. */
async function syncOne(db: SupabaseClient, source: Source, fx: Fx, trigger: string) {
  const startedAt = new Date()
  let logId: number | null = null

  try {
    const { data: logRow } = await db
      .from('sync_log')
      .insert({
        trigger,
        brand: source.brand,
        status: 'running',
        started_at: startedAt.toISOString(),
      })
      .select('id')
      .single()
    logId = logRow?.id ?? null

    const url =
      `https://docs.google.com/spreadsheets/d/${source.sheet_id}/export?format=xlsx`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Google Sheets returned ${res.status}`)

    const bytes = await res.arrayBuffer()
    const head = new Uint8Array(bytes.slice(0, 2))
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new Error(
        'Downloaded file is not an .xlsx. The sheet is probably not shared as ' +
        '"Anyone with the link can view".',
      )
    }

    const { rows, tabs, autoTabs, unreadableTabs, skippedRows, stats } =
      await readWorkbook(bytes, fx)
    if (!rows.length) throw new Error('Sheet parsed to zero rows; refusing to sync.')

    // Every row this run writes is stamped, then the prune removes whatever in this
    // brand's tabs was not stamped.
    const runAt = new Date().toISOString()
    let upserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        ...r,
        brand: source.brand,
        last_synced_at: runAt,
      }))
      const { error } = await db.from('creators').upsert(chunk, {
        onConflict: 'channel_link,brand,source_sheet,variant_no',
        defaultToNull: false,
      })
      if (error) throw new Error(`upsert: ${error.message}`)
      upserted += chunk.length
    }

    const { data: deleted, error: delErr } = await db.rpc('sync_prune_creators', {
      p_brand: source.brand,
      p_tabs: tabs,
      p_run_at: runAt,
    })
    if (delErr) throw new Error(`prune: ${delErr.message}`)

    const summary = {
      brand: source.brand,
      status: 'ok',
      tabs,
      tabs_auto_detected: autoTabs,
      tabs_unreadable: unreadableTabs,
      rows_in_sheet: stats.rowsRead,
      rows_upserted: upserted,
      rows_deleted: deleted ?? 0,
      dropped_header_or_marker: stats.dropped,
      skipped_no_url: stats.skippedNoUrl,
      skipped_rows: skippedRows,
      exact_duplicates_merged: stats.exactDuplicates,
      fees_unparsed: stats.feesUnparsed,
      geo_fields_repaired: stats.geoRepaired,
      fee_cells_holding_deliverables: stats.feeTextMoved,
      placeholder_values_cleared: stats.placeholdersCleared,
      duration_ms: Date.now() - startedAt.getTime(),
    }

    if (logId) {
      await db.from('sync_log').update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        rows_upserted: upserted,
        rows_deleted: deleted ?? 0,
        detail: summary,
      }).eq('id', logId)
    }
    await db.from('sheet_sources').update({
      last_run_at: new Date().toISOString(),
      last_status: 'ok',
      last_error: null,
      last_rows: upserted,
    }).eq('brand', source.brand)

    return summary
  } catch (err) {
    // One bad sheet must not stop the others, so this is reported rather than thrown.
    const message = err instanceof Error ? err.message : String(err)
    if (logId) {
      await db.from('sync_log').update({
        status: 'error',
        finished_at: new Date().toISOString(),
        error: message,
      }).eq('id', logId)
    }
    await db.from('sheet_sources').update({
      last_run_at: new Date().toISOString(),
      last_status: 'error',
      last_error: message,
    }).eq('brand', source.brand)
    return { brand: source.brand, status: 'error', error: message }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const provided = req.headers.get('x-sync-secret') ?? ''
  if (!provided) return json({ error: 'unauthorised' }, 401)

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Two callers, two secrets. SYNC_SECRET is held by the Apps Script trigger and the
  // app. The scheduled job sends a token the database generated for itself, so that
  // secret never has to be written into a cron command.
  let authorised = Boolean(SYNC_SECRET) && provided === SYNC_SECRET
  if (!authorised) {
    const { data: auth } = await db.from('sync_auth').select('token').eq('id', 1).single()
    authorised = Boolean(auth?.token) && provided === auth!.token
  }
  if (!authorised) return json({ error: 'unauthorised' }, 401)

  const body = await req.json().catch(() => ({}))
  const trigger = (body?.trigger as string) ?? 'unknown'
  const onlyBrand = (body?.brand as string) ?? null

  // Registering a new sheet: validate it is reachable before storing it, so a typo or
  // an unshared sheet fails here with a clear message rather than silently never syncing.
  if (body?.action === 'register') {
    const brand = String(body?.newBrand ?? '').trim()
    const sheetId = sheetIdFromUrl(String(body?.sheetUrl ?? ''))
    if (!brand) return json({ error: 'A brand name is required.' }, 400)
    if (!sheetId) {
      return json({ error: 'That does not look like a Google Sheets link.' }, 400)
    }

    const probe = await fetch(
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`,
      { redirect: 'follow' },
    )
    const bytes = probe.ok ? new Uint8Array(await probe.arrayBuffer()).slice(0, 2) : null
    if (!probe.ok || !bytes || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return json({
        error: 'Cannot read that sheet. In Google Sheets open Share and set ' +
               '"Anyone with the link" to Viewer, then try again.',
      }, 400)
    }

    const { error: insErr } = await db.from('sheet_sources').insert({
      brand,
      sheet_id: sheetId,
      sheet_url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    })
    if (insErr) {
      const dupe = insErr.message.includes('duplicate') || insErr.code === '23505'
      return json({
        error: dupe
          ? 'That brand name or that sheet is already connected.'
          : insErr.message,
      }, 400)
    }

    const fx = await loadFx(db)
    const result = await syncOne(db, { brand, sheet_id: sheetId }, fx, 'register')
    return json({ status: 'ok', registered: brand, first_sync: result })
  }

  // Normal path: sync every enabled sheet, or one named brand.
  let query = db.from('sheet_sources').select('brand,sheet_id').eq('enabled', true)
  if (onlyBrand) query = query.eq('brand', onlyBrand)
  const { data: sources, error: srcErr } = await query
  if (srcErr) return json({ status: 'error', error: srcErr.message }, 500)
  if (!sources?.length) {
    return json({ status: 'ok', message: 'No sheets connected.', sheets: [] })
  }

  const fx = await loadFx(db)
  const results = []
  for (const source of sources as Source[]) {
    results.push(await syncOne(db, source, fx, trigger))
  }

  const failed = results.filter((r) => r.status === 'error')
  return json({
    status: failed.length ? 'partial' : 'ok',
    trigger,
    sheets_synced: results.length,
    sheets_failed: failed.length,
    results,
  }, failed.length === results.length ? 500 : 200)
})

/** Conversion rates, loaded once per run rather than once per sheet. */
async function loadFx(db: SupabaseClient): Promise<Fx> {
  const { data } = await db.from('fx_rates').select('currency,usd_per_unit,as_of')
  const usdPerUnit: Record<string, number> = {}
  let asOf: string | null = null
  for (const r of data ?? []) {
    usdPerUnit[String(r.currency).toUpperCase()] = Number(r.usd_per_unit)
    if (!asOf || String(r.as_of) > asOf) asOf = String(r.as_of)
  }
  return { usdPerUnit, asOf }
}
