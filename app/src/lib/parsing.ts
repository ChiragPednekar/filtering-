/**
 * Cleaning rules ported from the Python ETL (etl.py) so an uploaded sheet is
 * normalised exactly the way the original load was. Keep the two in step.
 */

// '$' and '¥' are shared by several currencies; an explicit code in the text always
// wins over the symbol, and a bare '¥' is flagged in raw_data as a guess.
const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY',
  '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', '฿': 'THB', '₱': 'PHP',
  '₫': 'VND', '₴': 'UAH', '₽': 'RUB',
}

/**
 * Compound symbols like HK$ and CA$ must be checked before the bare '$', otherwise
 * every one of them reads as USD.
 */
const COMPOUND_SYMBOLS: [RegExp, string][] = [
  [/\bHK\s*\$/i, 'HKD'], [/\bNZ\s*\$/i, 'NZD'], [/\bCA\s*\$/i, 'CAD'],
  [/\bC\s*\$/i, 'CAD'],  [/\bAU\s*\$/i, 'AUD'], [/\bA\s*\$/i, 'AUD'],
  [/\bSG\s*\$/i, 'SGD'], [/\bS\s*\$/i, 'SGD'],  [/\bUS\s*\$/i, 'USD'],
  [/\bR\s*\$/i, 'BRL'],  [/\bNT\s*\$/i, 'TWD'],
]

/** Symbols that more than one currency uses, so the mapping is a best guess. */
const AMBIGUOUS_SYMBOLS = new Set(['¥'])

const CURRENCY_WORDS: Record<string, string> = {
  INR: 'INR', RS: 'INR', RUPEE: 'INR', RUPEES: 'INR',
  USD: 'USD', DOLLAR: 'USD', DOLLARS: 'USD',
  EUR: 'EUR', EURO: 'EUR', EUROS: 'EUR',
  GBP: 'GBP', POUND: 'GBP', POUNDS: 'GBP',
  AED: 'AED', CAD: 'CAD', AUD: 'AUD', SGD: 'SGD',
  BHD: 'BHD',
  SAR: 'SAR',
  QAR: 'QAR',
  KWD: 'KWD',
  OMR: 'OMR',
  CHF: 'CHF',
  SEK: 'SEK',
  NOK: 'NOK',
  DKK: 'DKK',
  PLN: 'PLN',
  ZAR: 'ZAR',
  NZD: 'NZD',
  JPY: 'JPY',
  BRL: 'BRL',
  MXN: 'MXN',
  PHP: 'PHP',
  IDR: 'IDR',
  MYR: 'MYR',
  THB: 'THB',
  TRY: 'TRY',
  PKR: 'PKR',
  BDT: 'BDT',
  LKR: 'LKR',
  NGN: 'NGN',
  KES: 'KES',
  CNY: 'CNY',
  RMB: 'CNY',
  HKD: 'HKD',
  TWD: 'TWD',
  KRW: 'KRW',
  ILS: 'ILS',
  VND: 'VND',
  UAH: 'UAH',
  RUB: 'RUB',
  EGP: 'EGP',
  MAD: 'MAD',
  COP: 'COP',
  ARS: 'ARS',
  CLP: 'CLP',
  PEN: 'PEN',
  RSD: 'RSD',
  ISK: 'ISK',
  BGN: 'BGN',
  RON: 'RON',
  CZK: 'CZK',
  HUF: 'HUF',
  VES: 'VES',
  GHS: 'GHS',
  TZS: 'TZS',
  UGX: 'UGX',
  ETB: 'ETB',
  XAF: 'XAF',
  XOF: 'XOF',
  MUR: 'MUR',
  JOD: 'JOD',
  IQD: 'IQD',
  DZD: 'DZD',
  TND: 'TND',
}

/** Several source tabs head the fee column "Commercials ( $ )". */
const DEFAULT_CURRENCY = 'USD'

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, m: 1e6,
  l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7,
}

const byLengthDesc = (a: string, b: string) => b.length - a.length
const CUR_WORD_RE = Object.keys(CURRENCY_WORDS).sort(byLengthDesc).join('|')
const MULT_RE = Object.keys(MULTIPLIERS).sort(byLengthDesc).join('|')

// Currency codes are bounded by letters, not word chars, so "4000EUR" still matches.
const MONEY_RE = new RegExp(
  `([$€£₹])?\\s*` +
  `(?:(?<![A-Za-z])(${CUR_WORD_RE})(?![A-Za-z])\\s*)?` +
  `([$€£₹])?\\s*` +
  `(\\d[\\d,]*(?:\\.\\d+)?)\\s*` +
  `(?:(${MULT_RE})\\b)?\\s*` +
  `(?:([$€£₹])|(?<![A-Za-z])(${CUR_WORD_RE})(?![A-Za-z]))?`,
  'gi',
)

const PERCENT_RE = /\d+(?:\.\d+)?\s*%/g
const NON_FEE_COUNT_RE =
  /\b\d+\s*(?:x|month|months|day|days|week|weeks|year|years|video|videos|reel|reels|post|posts|story|stories|short|shorts)\b/gi

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g
const PHONEISH_RE = /^[+\d][\d\s\-().]{6,}$/

export interface MoneyResult {
  amount: number | null
  currency: string | null
  all: { amount: number; currency: string }[]
  notes: Record<string, unknown>
}

/**
 * '$100', 'INR 24,000', '€450', '1500 Euros', 'INR 65K', '$2,100', 'INR 4L+GST',
 * '£3.5k+ VAT', '$3000 AUD' (explicit code beats the symbol), '$300/ $600'.
 * Multi-value cells return the LOWEST as `amount`, with every value in `all`.
 *
 * `currencyHint` comes from the cell's number format, which is where the sheets
 * record the currency for plain numeric cells.
 */
export function parseMoney(
  raw: string | null | undefined,
  currencyHint?: string | null,
): MoneyResult {
  const notes: Record<string, unknown> = {}
  const text = (raw ?? '').trim()
  if (!text) return { amount: null, currency: null, all: [], notes }

  const scrubbed = text.replace(PERCENT_RE, ' ').replace(NON_FEE_COUNT_RE, ' ')

  // A currency named anywhere in the cell applies to bare numbers inside it.
  let ambient: string | null = null
  let compound: string | null = null
  for (const [re, code] of COMPOUND_SYMBOLS) {
    if (re.test(text)) { ambient = compound = code; break }
  }
  if (ambient === null) for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(sym)) {
      ambient = code
      if (AMBIGUOUS_SYMBOLS.has(sym)) notes.fee_currency_symbol_ambiguous = sym
      break
    }
  }
  const wordHit = new RegExp(`(?<![A-Za-z])(${CUR_WORD_RE})(?![A-Za-z])`, 'i').exec(text)
  if (wordHit) ambient = CURRENCY_WORDS[wordHit[1].toUpperCase()]
  if (ambient === null && currencyHint) {
    // Nothing in the text says what currency this is, but the cell format does.
    ambient = currencyHint
    notes.fee_currency_from_cell_format = currencyHint
  }

  const parsed: { amount: number; currency: string; explicit: boolean }[] = []
  MONEY_RE.lastIndex = 0
  for (const m of scrubbed.matchAll(MONEY_RE)) {
    const [, pre, precode, pre2, num, mult, post, postcode] = m
    if (!num) continue
    let value = parseFloat(num.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    if (mult) value *= MULTIPLIERS[mult.toLowerCase()]

    let currency: string | null = null
    for (const sym of [pre, pre2, post]) if (sym) { currency = CURRENCY_SYMBOLS[sym]; break }
    // 'HK$ 4000' matches the bare '$' above; the compound prefix is what it means.
    if (currency !== null && compound !== null) currency = compound
    for (const code of [precode, postcode]) if (code) { currency = CURRENCY_WORDS[code.toUpperCase()]; break }

    const explicit = currency !== null
    if (!currency) currency = ambient ?? DEFAULT_CURRENCY
    // A bare small number with no currency anywhere is a stray count, not a fee.
    if (!explicit && ambient === null && value < 20) continue

    parsed.push({ amount: value, currency, explicit })
  }

  if (!parsed.length) {
    notes[/\d/.test(text) ? 'fee_unparsed' : 'fee_non_numeric'] = text
    return { amount: null, currency: null, all: [], notes }
  }

  const best = parsed.reduce((a, b) => (b.amount < a.amount ? b : a))
  const all = parsed.map(({ amount, currency }) => ({ amount, currency }))
  if (parsed.length > 1) notes.fee_all_values = all
  if (!best.explicit) notes.fee_currency_inferred = best.currency

  const excludes = ([['gst', 'GST'], ['vat', 'VAT'], ['paypal', 'PayPal fee'], ['agency', 'agency fee']] as const)
    .filter(([kw]) => new RegExp(kw, 'i').test(text))
    .map(([, label]) => label)
  if (excludes.length) notes.fee_excludes = excludes

  return { amount: best.amount, currency: best.currency, all, notes }
}

/** '207K' -> 207000, '1.2M' -> 1200000, '40.3L' -> 4030000. */
export function parseAudience(raw: string | null | undefined): { value: number | null; notes: Record<string, unknown> } {
  const text = (raw ?? '').trim().replace(/,/g, '')
  if (!text) return { value: null, notes: {} }
  const m = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${MULT_RE})?$`, 'i').exec(text)
  if (!m) return { value: null, notes: { audience_unparsed: raw } }
  let value = parseFloat(m[1])
  if (m[2]) value *= MULTIPLIERS[m[2].toLowerCase()]
  return { value: Math.round(value), notes: {} }
}

/** Split on , / | and & into a deduplicated array. */
export function parseCategories(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[,/|]|\s+&\s+/)) {
    const c = part.replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '')
    if (!c) continue
    const key = c.toLowerCase()
    if (!seen.has(key)) { seen.add(key); out.push(c) }
  }
  return out
}

/** Non-email values (a phone number, 'DM') yield null and are kept in raw_data. */
export function parseEmail(raw: string | null | undefined): { email: string | null; notes: Record<string, unknown> } {
  const notes: Record<string, unknown> = {}
  const text = (raw ?? '').trim()
  if (!text) return { email: null, notes }
  const found = text.match(EMAIL_RE)
  if (!found?.length) {
    notes.email_raw_non_email = text
    notes.email_raw_kind =
      PHONEISH_RE.test(text) || /wa\.me|whatsapp/i.test(text) ? 'phone_or_whatsapp' : 'placeholder'
    return { email: null, notes }
  }
  if (found.length > 1) notes.email_all = found
  return { email: found[0].toLowerCase(), notes }
}

const PLATFORM_PATTERNS: [string, RegExp][] = [
  ['YouTube', /youtube\.com|youtu\.be/i],
  ['Instagram', /instagram\.com/i],
  ['TikTok', /tiktok\.com/i],
  ['X', /(?:twitter|x)\.com/i],
  ['LinkedIn', /linkedin\.com/i],
  ['Twitch', /twitch\.tv/i],
  ['Facebook', /facebook\.com|fb\.com/i],
]

const PLATFORM_CANON: Record<string, string> = {
  youtube: 'YouTube', yt: 'YouTube', instagram: 'Instagram', ig: 'Instagram',
  tiktok: 'TikTok', tt: 'TikTok', x: 'X', twitter: 'X',
  linkedin: 'LinkedIn', twitch: 'Twitch', facebook: 'Facebook',
}

/** The URL is more reliable than the platform column, which sometimes holds a count. */
export function resolvePlatform(explicit: string | null | undefined, url: string | null | undefined): string | null {
  for (const [name, pat] of PLATFORM_PATTERNS) if (pat.test(url ?? '')) return name
  const key = (explicit ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (PLATFORM_CANON[key]) return PLATFORM_CANON[key]
  return explicit?.trim() || null
}

/** Canonical key form: https://host/path, lowercase host, no www., no trailing ?/. */
export function normalizeUrl(raw: string | null | undefined): { url: string | null; notes: Record<string, unknown> } {
  const text = (raw ?? '').trim()
  if (!text) return { url: null, notes: {} }
  if (!/https?:\/\/|\w+\.\w/.test(text)) {
    return { url: null, notes: { channel_link_not_a_url: text } }
  }
  let t = text.replace(/\s+/g, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    // Drop query strings and fragments: a profile's identity is its path. YouTube
    // share links carry '?si=<token>', which would otherwise split one creator in two.
    .split(/[?#]/)[0]
    .replace(/[/\s]+$/, '')
  const slash = t.indexOf('/')
  t = slash === -1 ? t.toLowerCase() : t.slice(0, slash).toLowerCase() + t.slice(slash)
  return { url: 'https://' + t, notes: {} }
}

/** YouTube reports subscribers; Instagram/TikTok report followers. */
export function routeAudience(platform: string | null, value: number | null) {
  if (value === null) return { subscribers: null, followers: null }
  const social = ['Instagram', 'TikTok', 'X', 'LinkedIn', 'Facebook', 'Twitch']
  if (platform === 'YouTube') return { subscribers: value, followers: null }
  if (platform && social.includes(platform)) return { subscribers: null, followers: value }
  return { subscribers: value, followers: null }
}
