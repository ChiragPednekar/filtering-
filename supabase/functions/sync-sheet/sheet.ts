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
import {
  looksLikeDeliverables, nullIfPlaceholder, repairGeoFields,
} from './repair.ts'

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

/**
 * Header text -> canonical field, so a tab nobody has configured still syncs. Without
 * this a new tab is silently ignored and its creators never reach the database.
 */
const HEADER_HINTS: [Field, RegExp][] = [
  ['channel_link', /^(channel\s*link|profile\s*link|url|link|channel|profile)$/i],
  ['mail', /^(mail|e-?mail|email\s*id|email\s*address|contact)$/i],
  ['category', /^(category|categories|niche|genre|vertical)$/i],
  ['language', /^(language|lang)$/i],
  ['country', /^(country|region|location|geo)$/i],
  ['audience', /^(subscribers?|followers?|subs|audience|reach|following)$/i],
  ['platform', /^(platform|channel\s*type|social)$/i],
  ['deliverables', /^(deliverables?|scope|package)$/i],
  ['commercials', /^(commercials?(\s*\(\s*\$?\s*\))?|rate|fee|price|cost|standard\s*fee|budget)$/i],
]

/** Build a layout from a tab's header row. Returns null if there is no link column. */
function layoutFromHeader(headers: string[]): Layout | null {
  const layout: Layout = {}
  const taken = new Set<Field>()
  headers.forEach((h, i) => {
    const clean = h.trim()
    if (!clean) return
    for (const [field, re] of HEADER_HINTS) {
      if (!taken.has(field) && re.test(clean)) {
        layout[field] = i
        taken.add(field)
        return
      }
    }
  })
  return layout.channel_link === undefined ? null : layout
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
  /** Tabs read from their header row because no layout was pinned for them. */
  autoTabs: string[]
  /** Tabs skipped because no column could be identified as the profile link. */
  unreadableTabs: string[]
  /** Rows dropped for having no usable URL, so they are visible rather than silent. */
  skippedRows: { tab: string; row: number; value: string }[]
  stats: {
    rowsRead: number
    dropped: number
    skippedNoUrl: number
    exactDuplicates: number
    feesUnparsed: number
    geoRepaired: number
    feeTextMoved: number
    placeholdersCleared: number
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
  const autoTabs: string[] = []
  const unreadableTabs: string[] = []
  const skippedRows: { tab: string; row: number; value: string }[] = []
  let rowsRead = 0, dropped = 0, skippedNoUrl = 0, feesUnparsed = 0
  let geoRepaired = 0, feeTextMoved = 0, placeholdersCleared = 0

  for (const name of wb.SheetNames) {
    if (EXCLUDED_TABS.has(name)) continue
    const ws = wb.Sheets[name]
    const ref = ws['!ref']
    if (!ref) continue
    const range = XLSX.utils.decode_range(ref)

    // Known tabs keep their pinned layout. Anything new is read from its header row,
    // so a tab the client adds starts syncing without a code change.
    let configured = TAB_LAYOUT[name]
    if (!configured) {
      const headerCells: string[] = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })]
        headerCells.push(cell?.v === undefined || cell.v === null ? '' : String(cell.v).trim())
      }
      const derived = layoutFromHeader(headerCells)
      if (!derived) {
        unreadableTabs.push(name)
        continue
      }
      configured = derived
      autoTabs.push(name)
    }
    tabs.push(name)

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
      if (!channelLink) {
        skippedNoUrl++
        // Recorded rather than dropped silently, so a creator with a broken link is
        // visible in the sync result instead of just vanishing.
        if (skippedRows.length < 50) {
          skippedRows.push({ tab: name, row: r + 1, value: rawLink.slice(0, 80) })
        }
        continue
      }

      const platform = resolvePlatform(get('platform'), rawLink)
      const { value: audience, notes: audNotes } = parseAudience(get('audience'))
      const { subscribers, followers } = routeAudience(platform, audience)
      const { email, notes: mailNotes } = parseEmail(get('mail'))

      // Placeholders ("Not Shared", "N/A") are absence of data, not data.
      const rawCountry = get('country')
      const rawLanguage = get('language')
      if (rawCountry && !nullIfPlaceholder(rawCountry)) placeholdersCleared++
      if (rawLanguage && !nullIfPlaceholder(rawLanguage)) placeholdersCleared++

      const geo = repairGeoFields({
        category: get('category'),
        language: rawLanguage,
        country: rawCountry,
      })
      if (geo.note) geoRepaired++

      let feeRaw = get('commercials')
      let deliverablesRaw = get('deliverables')
      const feeIdx = layout.commercials
      let feeHint = feeIdx === undefined ? null : (fmts[feeIdx] ?? null)

      // A fee cell holding deliverables text: move it where it belongs rather than
      // leaving the creator priceless and the text in the wrong column.
      let feeTextNote: Record<string, unknown> = {}
      if (looksLikeDeliverables(feeRaw)) {
        if (!deliverablesRaw) deliverablesRaw = feeRaw
        feeTextNote = { fee_cell_held_deliverables: feeRaw }
        feeRaw = ''
        feeHint = null
        feeTextMoved++
      }

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
        category: parseCategories(geo.category),
        country: geo.country,
        language: geo.language,
        platform,
        subscribers,
        followers,
        deliverables: deliverablesRaw || null,
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
          ...linkNotes, ...audNotes, ...mailNotes, ...money.notes, ...feeTextNote,
          ...(geo.note ? { [geo.note]: true } : {}),
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
    autoTabs,
    unreadableTabs,
    skippedRows,
    stats: {
      rowsRead, dropped, skippedNoUrl, exactDuplicates, feesUnparsed,
      geoRepaired, feeTextMoved, placeholdersCleared,
    },
  }
}
