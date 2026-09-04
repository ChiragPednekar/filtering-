/**
 * sync-sheet — pulls the source Google Sheet into `creators`.
 *
 * Triggered three ways, all hitting this one function:
 *   1. A Google Apps Script onChange trigger in the sheet  -> near-instant
 *   2. pg_cron every 15 minutes                            -> safety net
 *   3. The "Sync now" button in the desktop app            -> on demand
 *
 * Deletions mirror the sheet: a creator removed from a synced tab is removed here.
 * That only ever applies to tabs present in the workbook, so rows added through the
 * app's upload feature under a different source_sheet are never touched.
 *
 * Auth: requires the SYNC_SECRET header, so the public URL cannot be used to trigger
 * expensive syncs or to probe the database.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { readWorkbook } from './sheet.ts'

const SHEET_ID = Deno.env.get('SHEET_ID') ??
  '1wcqZydjxkeCS5qg16kd6c-5tVQc9jc62pgWKTsuhhog'
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SYNC_SECRET = Deno.env.get('SYNC_SECRET') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-sync-secret, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // A shared secret rather than the service key, so the trigger can live in a Google
  // Apps Script without handing that script full database access.
  const provided = req.headers.get('x-sync-secret') ?? ''
  if (!provided) return json({ error: 'unauthorised' }, 401)

  const startedAt = new Date()
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Two callers, two secrets. SYNC_SECRET is the one held by the Apps Script trigger
  // and the desktop app. The scheduled job instead sends a token the database
  // generated for itself, so that secret never has to be written into a cron command.
  let authorised = Boolean(SYNC_SECRET) && provided === SYNC_SECRET
  if (!authorised) {
    const { data: auth } = await db.from('sync_auth').select('token').eq('id', 1).single()
    authorised = Boolean(auth?.token) && provided === auth!.token
  }
  if (!authorised) return json({ error: 'unauthorised' }, 401)

  const trigger = (await req.json().catch(() => ({})))?.trigger ?? 'unknown'
  let logId: number | null = null

  try {
    const { data: logRow } = await db
      .from('sync_log')
      .insert({ trigger, status: 'running', started_at: startedAt.toISOString() })
      .select('id')
      .single()
    logId = logRow?.id ?? null

    // ---- fetch -------------------------------------------------------------
    const res = await fetch(EXPORT_URL, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Google Sheets returned ${res.status}`)
    const bytes = await res.arrayBuffer()
    const head = new Uint8Array(bytes.slice(0, 2))
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new Error(
        'Downloaded file is not an .xlsx. The sheet is probably no longer shared as ' +
        '"anyone with the link can view".',
      )
    }

    // Skip the whole parse when nothing changed. Google's export is not byte-stable,
    // so this is a cheap best-effort short-circuit, not the correctness mechanism.
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sheetHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('')

    // ---- rates -------------------------------------------------------------
    const { data: fxRows, error: fxErr } = await db
      .from('fx_rates').select('currency,usd_per_unit,as_of')
    if (fxErr) throw new Error(`fx_rates: ${fxErr.message}`)
    const usdPerUnit: Record<string, number> = {}
    let asOf: string | null = null
    for (const r of fxRows ?? []) {
      usdPerUnit[String(r.currency).toUpperCase()] = Number(r.usd_per_unit)
      if (!asOf || String(r.as_of) > asOf) asOf = String(r.as_of)
    }

    // ---- transform ---------------------------------------------------------
    const { rows, tabs, autoTabs, unreadableTabs, skippedRows, stats } =
      await readWorkbook(bytes, { usdPerUnit, asOf })
    if (!rows.length) throw new Error('Sheet parsed to zero rows; refusing to sync.')

    // ---- load --------------------------------------------------------------
    // Every row this run writes is stamped with runAt; the prune then removes
    // whatever in these tabs was not stamped. Sending one key per row instead meant a
    // ~1,255-element array through PostgREST, which failed converting JSON to text.
    const runAt = new Date().toISOString()
    let upserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, last_synced_at: runAt }))
      const { error } = await db.from('creators').upsert(chunk, {
        onConflict: 'channel_link,source_sheet,variant_no',
        defaultToNull: false,
      })
      if (error) throw new Error(`upsert: ${error.message}`)
      upserted += chunk.length
    }

    // Upsert first, then prune, so a failure mid-run never leaves the table short.
    const { data: deleted, error: delErr } = await db.rpc('sync_prune_creators', {
      p_tabs: tabs,
      p_run_at: runAt,
    })
    if (delErr) throw new Error(`prune: ${delErr.message}`)

    const summary = {
      status: 'ok',
      trigger,
      tabs,
      // Tabs picked up from their header row because no layout was pinned for them.
      tabs_auto_detected: autoTabs,
      // Tabs skipped entirely: no column could be identified as the profile link.
      tabs_unreadable: unreadableTabs,
      rows_in_sheet: stats.rowsRead,
      rows_upserted: upserted,
      rows_deleted: deleted ?? 0,
      dropped_header_or_marker: stats.dropped,
      skipped_no_url: stats.skippedNoUrl,
      // Which rows those were, so a broken link is visible rather than silent.
      skipped_rows: skippedRows,
      exact_duplicates_merged: stats.exactDuplicates,
      fees_unparsed: stats.feesUnparsed,
      geo_fields_repaired: stats.geoRepaired,
      fee_cells_holding_deliverables: stats.feeTextMoved,
      placeholder_values_cleared: stats.placeholdersCleared,
      sheet_hash: sheetHash.slice(0, 16),
      duration_ms: Date.now() - startedAt.getTime(),
    }

    if (logId) {
      await db.from('sync_log').update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        rows_upserted: upserted,
        rows_deleted: deleted ?? 0,
        sheet_hash: sheetHash.slice(0, 16),
        detail: summary,
      }).eq('id', logId)
    }

    return json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (logId) {
      await db.from('sync_log').update({
        status: 'error',
        finished_at: new Date().toISOString(),
        error: message,
      }).eq('id', logId)
    }
    return json({ status: 'error', trigger, error: message }, 500)
  }
})
