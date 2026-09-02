import * as XLSX from 'xlsx'
import { supabaseAdmin, describeError } from '../lib/supabaseClient'
import type { FxRates } from './creatorsService'
import {
  normalizeUrl, parseCategories, parseEmail, parseMoney,
  parseAudience, resolvePlatform, routeAudience,
} from '../lib/parsing'
import type { CanonicalField, MappedRow } from '../types'

export interface ParsedSheet {
  name: string
  headers: string[]
  rows: string[][]
  /**
   * Currency implied by each cell's number format, same shape as `rows`.
   * The sheets record currency this way for plain numeric cells: a cell holding
   * 3500 formatted as '"\u00a3"#,##0' displays as £3,500 and means GBP. Reading only
   * the value would silently turn pounds into dollars.
   */
  formats: (string | null)[][]
}

export interface ParsedWorkbook {
  fileName: string
  sheets: ParsedSheet[]
}

/** Header text -> canonical field. Mirrors the tab variations in the source workbook. */
const HEADER_HINTS: Record<CanonicalField, RegExp> = {
  channel_link: /^(channel\s*link|profile\s*link|url|link|channel|profile)$/i,
  mail: /^(mail|e-?mail|email\s*id|email\s*address|contact)$/i,
  category: /^(category|categories|niche|genre|vertical)$/i,
  country: /^(country|region|location|geo)$/i,
  language: /^(language|lang)$/i,
  platform: /^(platform|channel\s*type|social)$/i,
  audience: /^(subscribers?|followers?|subs|audience|reach|following)$/i,
  deliverables: /^(deliverables?|scope|package)$/i,
  commercials: /^(commercials?|commercials?\s*\(\s*\$\s*\)|rate|fee|price|cost|standard\s*fee|budget)$/i,
}

/** Best-effort initial mapping; the user confirms or overrides it in the UI. */
export function autoMapHeaders(headers: string[]): Record<number, CanonicalField | ''> {
  const mapping: Record<number, CanonicalField | ''> = {}
  const taken = new Set<CanonicalField>()
  headers.forEach((h, i) => {
    const clean = h.trim()
    if (!clean) {
      mapping[i] = ''
      return
    }
    const hit = (Object.entries(HEADER_HINTS) as [CanonicalField, RegExp][])
      .find(([field, re]) => !taken.has(field) && re.test(clean))
    if (hit) {
      mapping[i] = hit[0]
      taken.add(hit[0])
    } else {
      mapping[i] = ''
    }
  })
  return mapping
}

const NUMBER_FORMAT_CURRENCY: [string, string][] = [
  ['\u00a3', 'GBP'], ['\u20ac', 'EUR'], ['\u20b9', 'INR'],
  ['$', 'USD'], ['AED', 'AED'], ['INR', 'INR'],
]

function currencyFromFormat(numberFormat: string | undefined): string | null {
  for (const [token, code] of NUMBER_FORMAT_CURRENCY) {
    if (numberFormat?.includes(token)) return code
  }
  return null
}

/** Read an .xlsx/.xls/.csv entirely in the renderer -- no upload to any server. */
export async function parseFile(file: File): Promise<ParsedWorkbook> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true })

  const sheets: ParsedSheet[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const ref = ws['!ref']
    if (!ref) return { name, headers: [], rows: [], formats: [] }
    const range = XLSX.utils.decode_range(ref)

    const grid: string[][] = []
    const formats: (string | null)[][] = []

    for (let r = range.s.r; r <= range.e.r; r++) {
      const rowText: string[] = []
      const rowFmt: (string | null)[] = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        // cell.v is the underlying value; storing that (not the formatted cell.w)
        // keeps `commercials` verbatim, matching the Python ETL.
        rowText.push(cell?.v === undefined || cell.v === null ? '' : String(cell.v).trim())
        rowFmt.push(cell?.t === 'n' ? currencyFromFormat(cell.z as string | undefined) : null)
      }
      if (rowText.some((t) => t)) {
        grid.push(rowText)
        formats.push(rowFmt)
      }
    }

    if (!grid.length) return { name, headers: [], rows: [], formats: [] }
    return {
      name,
      headers: grid[0].map((h) => h.trim()),
      rows: grid.slice(1),
      formats: formats.slice(1),
    }
  })

  return { fileName: file.name, sheets: sheets.filter((s) => s.headers.length) }
}

const isRepeatHeader = (row: string[]) =>
  /^(channel\s*link|profile\s*link)$/i.test((row[0] ?? '').trim())

const isMarkerRow = (row: string[]) =>
  Boolean((row[0] ?? '').trim()) && row.slice(1).every((c) => !c.trim())

async function fingerprint(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface MapResult {
  rows: MappedRow[]
  skippedNoUrl: number
  exactDuplicates: number
  droppedRows: number
}

/** Apply the confirmed column mapping and clean every row. */
export async function mapRows(
  sheet: ParsedSheet,
  mapping: Record<number, CanonicalField | ''>,
  sourceSheet: string,
  fx?: FxRates,
): Promise<MapResult> {
  const colFor = (field: CanonicalField): number => {
    const hit = Object.entries(mapping).find(([, f]) => f === field)
    return hit ? Number(hit[0]) : -1
  }
  const idx = Object.fromEntries(
    (Object.keys(HEADER_HINTS) as CanonicalField[]).map((f) => [f, colFor(f)]),
  ) as Record<CanonicalField, number>

  const get = (row: string[], f: CanonicalField) =>
    idx[f] >= 0 ? (row[idx[f]] ?? '').trim() : ''

  const mapped: MappedRow[] = []
  let skippedNoUrl = 0
  let droppedRows = 0

  for (const [i, row] of sheet.rows.entries()) {
    if (!row.some((c) => c.trim())) {
      droppedRows++
      continue
    }
    if (isRepeatHeader(row) || isMarkerRow(row)) {
      droppedRows++
      continue
    }

    const rawLink = get(row, 'channel_link')
    const { url: channelLink, notes: linkNotes } = normalizeUrl(rawLink)
    if (!channelLink) {
      skippedNoUrl++
      continue
    }

    const platform = resolvePlatform(get(row, 'platform'), rawLink)
    const { value: audience, notes: audNotes } = parseAudience(get(row, 'audience'))
    const { subscribers, followers } = routeAudience(platform, audience)
    const { email, notes: mailNotes } = parseEmail(get(row, 'mail'))
    const feeRaw = get(row, 'commercials')
    const feeIdx = idx.commercials
    const feeHint = feeIdx >= 0 ? (sheet.formats[i]?.[feeIdx] ?? null) : null
    const money = parseMoney(feeRaw, feeHint)

    // Fees are stored in USD so one filter means one thing; the quoted figure is kept
    // in *_native. Rates come from the fx_rates table, matching the stored rows.
    const rate =
      money.currency && fx ? (fx.usdPerUnit[money.currency.toUpperCase()] ?? null) : null
    const usdAmount =
      money.amount !== null && rate !== null
        ? Math.round(money.amount * rate * 100) / 100
        : null

    const original: Record<string, string> = {}
    sheet.headers.forEach((h, c) => {
      if (row[c]?.trim()) original[h || `col_${c}`] = row[c].trim()
    })

    mapped.push({
      channel_link: channelLink,
      profile_link: rawLink && rawLink !== channelLink ? rawLink : null,
      mail: email,
      email_id: email,
      category: parseCategories(get(row, 'category')),
      country: get(row, 'country') || null,
      language: get(row, 'language') || null,
      platform,
      subscribers,
      followers,
      deliverables: get(row, 'deliverables') || null,
      commercials: feeRaw || null,
      commercials_amount: usdAmount ?? money.amount,
      commercials_currency: usdAmount !== null ? 'USD' : money.currency,
      commercials_amount_native: money.amount,
      commercials_currency_native: money.currency,
      fx_rate: rate,
      fx_rate_date: rate !== null ? (fx?.asOf ?? null) : null,
      source_sheet: sourceSheet,
      variant_no: 1,
      raw_data: {
        source_tab: sheet.name,
        source_row: i + 2,
        uploaded_at: new Date().toISOString(),
        original,
        ...linkNotes,
        ...audNotes,
        ...mailNotes,
        ...money.notes,
        ...(money.all.length ? { fee_parsed: money.all } : {}),
        ...(money.amount !== null && rate === null
          ? { fx_unconvertible_currency: money.currency }
          : {}),
      },
    })
  }

  // Collapse byte-identical repeats, then number genuine variants -- a creator can
  // legitimately appear twice in one sheet with different deliverable packages.
  // variant_no comes from a content hash, so re-uploading a reordered sheet still
  // maps each row back to the same record.
  const groups = new Map<string, MappedRow[]>()
  for (const r of mapped) {
    const key = `${r.channel_link} ${r.source_sheet}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  const out: MappedRow[] = []
  let exactDuplicates = 0
  for (const members of groups.values()) {
    const byPrint = new Map<string, MappedRow>()
    for (const m of members) {
      // profile_link is provenance -- the URL as written -- not data. Two rows for the
      // same creator that differ only by a '?si=' share token are the same record.
      const {
        raw_data: _rawData,
        profile_link: _profileLink,
        // Derived from the native figure; a rate refresh must not renumber variants.
        commercials_amount: _usdAmount,
        commercials_currency: _usdCurrency,
        fx_rate: _fxRate,
        fx_rate_date: _fxDate,
        ...rest
      } = m
      const print = await fingerprint(JSON.stringify(rest, Object.keys(rest).sort()))
      if (byPrint.has(print)) {
        exactDuplicates++
      } else {
        byPrint.set(print, m)
      }
    }
    const ordered = [...byPrint.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    ordered.forEach(([, row], i) => {
      row.variant_no = i + 1
      out.push(row)
    })
  }

  return { rows: out, skippedNoUrl, exactDuplicates, droppedRows }
}

export interface UploadSummary {
  inserted: number
  updated: number
  total: number
}

/**
 * Upsert on (channel_link, source_sheet, variant_no) -- the table's unique key.
 * ON CONFLICT (channel_link) alone would error: no such constraint exists, because
 * one creator can hold different negotiated fees in different sheets.
 */
export async function upsertRows(
  rows: MappedRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<UploadSummary> {
  if (!supabaseAdmin) {
    throw new Error(
      'Uploads need the service role key. Set VITE_SUPABASE_SERVICE_ROLE_KEY and restart.',
    )
  }
  if (!rows.length) return { inserted: 0, updated: 0, total: 0 }

  // Which keys already exist, so the summary can separate new from updated.
  const existing = new Set<string>()
  const sheets = [...new Set(rows.map((r) => r.source_sheet))]
  for (const sheet of sheets) {
    const links = rows.filter((r) => r.source_sheet === sheet).map((r) => r.channel_link)
    for (let i = 0; i < links.length; i += 500) {
      const { data, error } = await supabaseAdmin
        .from('creators')
        .select('channel_link,source_sheet,variant_no')
        .eq('source_sheet', sheet)
        .in('channel_link', links.slice(i, i + 500))
      if (error) throw new Error(describeError(error))
      for (const r of data ?? []) {
        existing.add(`${r.channel_link} ${r.source_sheet} ${r.variant_no}`)
      }
    }
  }

  const batchSize = 250
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabaseAdmin
      .from('creators')
      .upsert(rows.slice(i, i + batchSize), {
        onConflict: 'channel_link,source_sheet,variant_no',
        defaultToNull: false,
      })
    if (error) throw new Error(describeError(error))
    onProgress?.(Math.min(i + batchSize, rows.length), rows.length)
  }

  let updated = 0
  for (const r of rows) {
    if (existing.has(`${r.channel_link} ${r.source_sheet} ${r.variant_no}`)) updated++
  }
  return { inserted: rows.length - updated, updated, total: rows.length }
}
