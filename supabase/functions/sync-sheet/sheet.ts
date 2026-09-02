/**
 * Reads the source Google Sheet and maps every tab onto the canonical schema.
 *
 * This mirrors etl.py. The one deliberate difference is layout detection: etl.py
 * hardcodes the row range of Sheet2's second block, which is fine for a one-off load
 * but breaks the moment someone inserts a row. A live sync cannot assume fixed row
 * numbers, so the layout is decided per row from the cell contents instead.
 */
// 0.18.5 is the last SheetJS release on npm; the Edge Function bundler cannot
// reach SheetJS's own CDN. It supports cellNF/cell.z, which is what we need.
import * as XLSX from 'npm:xlsx@0.18.5'
import {
  normalizeUrl, parseAudience, parseCategories, parseEmail, parseMoney,
  resolvePlatform, routeAudience,
} from './parsing.ts'

export const EXCLUDED_TABS = new Set(['Higgs CreatorsGen AI Creators'])

type Field =
  | 'channel_link' | 'mail' | 'category' | 'country' | 'language'
  | 'platform' | 'audience' | 'deliverables' | 'commercials'

type Layout = Partial<Record<Field, number>>

/** Channel Link, Mail, Category, Country, Subs, Platform, Deliverables, Commercials */
const L8: Layout = {
  channel_link: 0, mail: 1, category: 2, country: 3,
  audience: 4, platform: 5, deliverables: 6, commercials: 7,
}
/** ...with Language inserted at 3, shifting everything after it right. */
const L9: Layout = {
  channel_link: 0, mail: 1, category: 2, language: 3, country: 4,
  audience: 5, platform: 6, deliverables: 7, commercials: 8,
}
/** Sheet8 swaps Commercials and Deliverables. */
const L9_SWAP: Layout = { ...L9, commercials: 7, deliverables: 8 }
/** Sheet7 has no email column at all. */
const L_NO_EMAIL: Layout = {
  channel_link: 0, category: 1, language: 2, country: 3,
  audience: 4, platform: 5, deliverables: 6, commercials: 7,
}

/** 'auto' picks L8 or L9 per row -- Sheet2 contains both. */
const TAB_LAYOUT: Record<string, Layout | 'auto'> = {
  Sheet2: 'auto',
  Sheet3: L9,
  Sheet6: L9,
  Sheet7: L_NO_EMAIL,
  Sheet8: L9_SWAP,
  Sheet9: L9,
}

const AUDIENCE_RE = /^\d[\d.,]*\s*(k|m|l|lakhs?|lacs?|cr)?$/i

/**
 * Decide between the 8- and 9-column layouts from the row itself: whichever position
 * holds an audience figure (207K, 1.2M, 4700) tells us where the columns start.
 */
function layoutForRow(cells: string[]): Layout {
  const looksLikeAudience = (i: number) => AUDIENCE_RE.test((cells[i] ?? '').trim())
  if (looksLikeAudience(4) && !looksLikeAudience(5)) return L8
  if (looksLikeAudience(5) && !looksLikeAudience(4)) return L9
  // Ambiguous or both blank: fall back on whether a language-looking value sits at 3.
  const c3 = (cells[3] ?? '').trim()
  const c4 = (cells[4] ?? '').trim()
  if (c3 && c4 && !/\d/.test(c3) && !/\d/.test(c4)) return L9
  return L8
}

const isRepeatHeader = (row: string[]) =>
  /^(channel\s*link|profile\s*link)$/i.test((row[0] ?? '').trim())

const isMarkerRow = (row: string[]) =>
  Boolean((row[0] ?? '').trim()) && row.slice(1).every((c) => !c.trim())

const NUMBER_FORMAT_CURRENCY: [string, string][] = [
  ['£', 'GBP'], ['€', 'EUR'], ['₹', 'INR'],
  ['$', 'USD'], ['AED', 'AED'], ['INR', 'INR'],
]

function currencyFromFormat(fmt: string | undefined): string | null {
  for (const [token, code] of NUMBER_FORMAT_CURRENCY) {
    if (fmt?.includes(token)) return code
  }
  return null
}

export interface SheetRow {
  channel_link: string
  profile_link: string | null
  mail: string | null
  email_id: string | null
  category: string[]
  country: string | null
  language: string | null
  platform: string | null
  subscribers: number | null
  followers: number | null
  deliverables: string | null
  commercials: string | null
  commercials_amount: number | null
  commercials_currency: string | null
  commercials_amount_native: number | null
  commercials_currency_native: string | null
  fx_rate: number | null
  fx_rate_date: string | null
  source_sheet: string
  variant_no: number
  row_fingerprint: string
  raw_data: Record<string, unknown>
}

export interface ReadResult {
  rows: SheetRow[]
  tabs: string[]
  stats: {
    rowsRead: number
    dropped: number
    skippedNoUrl: number
    exactDuplicates: number
    feesUnparsed: number
  }
}

async function sha1(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fields that define a row's identity. Provenance (profile_link, raw_data) and
 * FX-derived values are excluded, so a rate refresh never renumbers variants.
 * etl.py uses the same list in the same order -- keep them in step.
 */
const FINGERPRINT_FIELDS = [
  'channel_link', 'source_sheet', 'mail', 'category', 'country', 'language',
  'platform', 'subscribers', 'followers', 'deliverables', 'commercials',
  'commercials_amount_native', 'commercials_currency_native',
] as const

/**
 * Canonical content hash, computed identically here and in etl.py. Hashing a JSON
 * dump would not work: the two languages serialise differently, so the digests -- and
 * therefore the variant_no ordering -- would disagree and the pipelines would rewrite
 * each other's rows on every sync.
 */
function fingerprintOf(row: SheetRow): string {
  const parts = FINGERPRINT_FIELDS.map((f) => {
    const v = (row as unknown as Record<string, unknown>)[f]
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) return v.join(',')
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)
    }
    return String(v)
  })
  return parts.join('\x1f')
}

export async function readWorkbook(
  bytes: ArrayBuffer,
  fx: { usdPerUnit: Record<string, number>; asOf: string | null },
): Promise<ReadResult> {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true })

  const mapped: SheetRow[] = []
  const tabs: string[] = []
  let rowsRead = 0, dropped = 0, skippedNoUrl = 0, feesUnparsed = 0

  for (const name of wb.SheetNames) {
    if (EXCLUDED_TABS.has(name)) continue
    const configured = TAB_LAYOUT[name]
    if (!configured) continue // unknown tab: ignore rather than guess
    tabs.push(name)

    const ws = wb.Sheets[name]
    const ref = ws['!ref']
    if (!ref) continue
    const range = XLSX.utils.decode_range(ref)

    for (let r = range.s.r + 1; r <= range.e.r; r++) { // +1 skips the header row
      const cells: string[] = []
      const fmts: (string | null)[] = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        // Normalise CRLF to LF: openpyxl does this on read, SheetJS does not, and a
        // multi-line deliverables cell would otherwise differ between the pipelines.
        cells.push(
          cell?.v === undefined || cell.v === null
            ? ''
            : String(cell.v).replace(/\r\n/g, '\n').trim(),
        )
        fmts.push(cell?.t === 'n' ? currencyFromFormat(cell.z as string | undefined) : null)
      }
      if (!cells.some((x) => x)) continue
      rowsRead++
      if (isRepeatHeader(cells) || isMarkerRow(cells)) { dropped++; continue }

      const layout = configured === 'auto' ? layoutForRow(cells) : configured
      const get = (f: Field) => {
        const i = layout[f]
        return i === undefined ? '' : (cells[i] ?? '').trim()
      }

      const rawLink = get('channel_link')
      const { url: channelLink, notes: linkNotes } = normalizeUrl(rawLink)
      if (!channelLink) { skippedNoUrl++; continue }

      const platform = resolvePlatform(get('platform'), rawLink)
      const { value: audience, notes: audNotes } = parseAudience(get('audience'))
      const { subscribers, followers } = routeAudience(platform, audience)
      const { email, notes: mailNotes } = parseEmail(get('mail'))

      const feeRaw = get('commercials')
      const feeIdx = layout.commercials
      const feeHint = feeIdx === undefined ? null : (fmts[feeIdx] ?? null)
      const money = parseMoney(feeRaw, feeHint)
      if (feeRaw && money.amount === null) feesUnparsed++

      const rate = money.currency
        ? (fx.usdPerUnit[money.currency.toUpperCase()] ?? null)
        : null
      const usd = money.amount !== null && rate !== null
        ? Math.round(money.amount * rate * 100) / 100
        : null

      const original: Record<string, string> = {}
      for (const [f, i] of Object.entries(layout)) {
        const v = (cells[i as number] ?? '').trim()
        if (v) original[f] = v
      }

      mapped.push({
        channel_link: channelLink,
        profile_link: rawLink && rawLink !== channelLink ? rawLink : null,
        mail: email,
        email_id: email,
        category: parseCategories(get('category')),
        country: get('country') || null,
        language: get('language') || null,
        platform,
        subscribers,
        followers,
        deliverables: get('deliverables') || null,
        commercials: feeRaw || null,
        commercials_amount: usd ?? money.amount,
        commercials_currency: usd !== null ? 'USD' : money.currency,
        commercials_amount_native: money.amount,
        commercials_currency_native: money.currency,
        fx_rate: rate,
        fx_rate_date: rate !== null ? fx.asOf : null,
        source_sheet: name,
        variant_no: 1,
        row_fingerprint: '',
        raw_data: {
          source_tab: name,
          source_row: r + 1,
          synced_at: new Date().toISOString(),
          original,
          ...linkNotes, ...audNotes, ...mailNotes, ...money.notes,
          ...(money.all.length ? { fee_parsed: money.all } : {}),
          ...(money.amount !== null && rate === null
            ? { fx_unconvertible_currency: money.currency }
            : {}),
        },
      })
    }
  }

  // Collapse byte-identical repeats, then number genuine variants. Provenance and
  // FX-derived values are excluded so a rate refresh never renumbers anything.
  const groups = new Map<string, SheetRow[]>()
  for (const row of mapped) {
    const key = `${row.channel_link} ${row.source_sheet}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const rows: SheetRow[] = []
  let exactDuplicates = 0
  for (const members of groups.values()) {
    const byPrint = new Map<string, SheetRow>()
    for (const m of members) {
      const print = await sha1(fingerprintOf(m))
      if (byPrint.has(print)) exactDuplicates++
      else byPrint.set(print, m)
    }
    // Plain code-unit comparison, not localeCompare: Python sorts these hex digests
    // bytewise, and locale collation can order them differently, which would assign
    // variant_no differently in the two pipelines.
    const ordered = [...byPrint.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )
    ordered.forEach(([print, row], i) => {
      row.variant_no = i + 1
      row.row_fingerprint = print.slice(0, 16)
      rows.push(row)
    })
  }

  return {
    rows,
    tabs,
    stats: { rowsRead, dropped, skippedNoUrl, exactDuplicates, feesUnparsed },
  }
}
