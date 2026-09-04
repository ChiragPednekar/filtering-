/** A row of the `creators` table, as the app reads it. */
export interface Creator {
  id: number
  channel_link: string
  /** Derived from the profile handle -- the sheets carry no name column. */
  creator_name: string | null
  profile_link: string | null
  mail: string | null
  email_id: string | null
  category: string[] | null
  country: string | null
  language: string | null
  platform: string | null
  subscribers: number | null
  followers: number | null
  deliverables: string | null
  commercials: string | null
  /** Always USD. The quoted figure is in commercials_amount_native. */
  commercials_amount: number | null
  commercials_currency: string | null
  commercials_amount_native: number | null
  commercials_currency_native: string | null
  fx_rate: number | null
  fx_rate_date: string | null
  source_sheet: string
  variant_no: number
  /** Which connected sheet this row came from. */
  brand: string
  raw_data: Record<string, unknown> | null
}

export interface NumericRange {
  min: number | null
  max: number | null
}

export interface Filters {
  /** Matches creator name, link, email, deliverables and the raw fee text. */
  search: string
  /** Which connected sheet a row came from. */
  brands: string[]
  categories: string[]
  /** 'any' -> row has at least one selected category; 'all' -> row has every one. */
  categoryMode: 'any' | 'all'
  countries: string[]
  languages: string[]
  platforms: string[]
  currencies: string[]
  sourceSheets: string[]
  subscribers: NumericRange
  followers: NumericRange
  commercialsAmount: NumericRange
  /** Hide rows with no parsed fee. */
  onlyWithFee: boolean
}

export const EMPTY_FILTERS: Filters = {
  search: '',
  brands: [],
  categories: [],
  categoryMode: 'any',
  countries: [],
  languages: [],
  platforms: [],
  currencies: [],
  sourceSheets: [],
  subscribers: { min: null, max: null },
  followers: { min: null, max: null },
  commercialsAmount: { min: null, max: null },
  onlyWithFee: false,
}

/** One selectable value. Categories carry a label because the sheets spell them
 *  inconsistently ('ai' / 'Ai' / 'AI'); we filter on `value`, display `label`. */
export interface Option {
  value: string
  label: string
  count?: number
}

/** Distinct values present in the database, used to build the filter controls. */
export interface FilterOptions {
  categories: Option[]
  brands: string[]
  countries: string[]
  languages: string[]
  platforms: string[]
  currencies: string[]
  source_sheets: string[]
  ranges: {
    subscribers: { min: number; max: number }
    followers: { min: number; max: number }
    commercials_amount: { min: number; max: number }
  }
  /** When the stored USD conversion rates were taken. */
  fx: { as_of: string | null; source: string | null }
  total_rows: number
}

/** One row after mapping an uploaded sheet onto the canonical schema. */
export interface MappedRow {
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
  /** Always USD. The quoted figure is in commercials_amount_native. */
  commercials_amount: number | null
  commercials_currency: string | null
  commercials_amount_native: number | null
  commercials_currency_native: string | null
  fx_rate: number | null
  fx_rate_date: string | null
  source_sheet: string
  variant_no: number
  raw_data: Record<string, unknown>
}

/** The canonical fields an uploaded column can be mapped onto. */
export const CANONICAL_FIELDS = [
  { key: 'channel_link', label: 'Channel / Profile link', required: true },
  { key: 'mail', label: 'Email', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'country', label: 'Country', required: false },
  { key: 'language', label: 'Language', required: false },
  { key: 'platform', label: 'Platform', required: false },
  { key: 'audience', label: 'Subscribers / Followers', required: false },
  { key: 'deliverables', label: 'Deliverables', required: false },
  { key: 'commercials', label: 'Commercials / Rate / Fee', required: false },
] as const

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]['key']
