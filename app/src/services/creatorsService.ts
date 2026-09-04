import { supabase, describeError } from '../lib/supabaseClient'
import type { Creator, FilterOptions, Filters } from '../types'

/** Columns the results grid needs. Selecting explicitly keeps raw_data off the wire. */
const LIST_COLUMNS =
  'id,channel_link,creator_name,profile_link,mail,email_id,category,country,language,' +
  'platform,subscribers,followers,deliverables,commercials,commercials_amount,' +
  'commercials_currency,commercials_amount_native,commercials_currency_native,' +
  'fx_rate,fx_rate_date,source_sheet,variant_no,brand,manually_added'

export type SortKey =
  | 'creator_name' | 'channel_link' | 'country' | 'platform'
  | 'subscribers' | 'followers' | 'commercials_amount'

export interface QueryArgs {
  filters: Filters
  page: number
  pageSize: number
  sortKey: SortKey
  sortAsc: boolean
}

export interface PageResult {
  rows: Creator[]
  total: number
}

/**
 * Applies every active filter with AND semantics. Kept separate from the fetch so
 * the count and the page query cannot drift apart.
 */
function applyFilters<T>(query: T, f: Filters): T {
  // `q` is PostgrestFilterBuilder; typing it precisely fights the generic chain.
  let q = query as any

  if (f.search.trim()) {
    const term = `%${f.search.trim().replace(/[%,]/g, '')}%`
    q = q.or(
      [
        `creator_name.ilike.${term}`,
        `channel_link.ilike.${term}`,
        `mail.ilike.${term}`,
        `deliverables.ilike.${term}`,
        `commercials.ilike.${term}`,
      ].join(','),
    )
  }

  if (f.categories.length) {
    // category_norm is the lowercased generated column, so 'ai' matches 'AI'/'Ai'.
    // contains -> row must have ALL selected; overlaps -> ANY of them.
    const values = f.categories.map((c) => c.toLowerCase())
    q = f.categoryMode === 'all'
      ? q.contains('category_norm', values)
      : q.overlaps('category_norm', values)
  }

  if (f.brands.length) q = q.in('brand', f.brands)
  if (f.countries.length) q = q.in('country', f.countries)
  if (f.languages.length) q = q.in('language', f.languages)
  if (f.platforms.length) q = q.in('platform', f.platforms)
  // Every stored fee is USD, so this filters on the currency it was quoted in.
  if (f.currencies.length) q = q.in('commercials_currency_native', f.currencies)
  if (f.sourceSheets.length) q = q.in('source_sheet', f.sourceSheets)

  const range = (col: string, r: { min: number | null; max: number | null }) => {
    if (r.min !== null) q = q.gte(col, r.min)
    if (r.max !== null) q = q.lte(col, r.max)
  }
  range('subscribers', f.subscribers)
  range('followers', f.followers)
  range('commercials_amount', f.commercialsAmount)

  if (f.onlyWithFee) q = q.not('commercials_amount', 'is', null)

  return q as T
}

/** One page of results plus the total count for the same filter set. */
export async function fetchCreators(args: QueryArgs): Promise<PageResult> {
  const { filters, page, pageSize, sortKey, sortAsc } = args
  const from = (page - 1) * pageSize

  let query = supabase
    .from('creators')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order(sortKey, { ascending: sortAsc, nullsFirst: false })
    // Stable tiebreak so paging never repeats or skips a row.
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1)

  query = applyFilters(query, filters)

  const { data, error, count } = await query
  if (error) throw new Error(describeError(error))
  return { rows: (data ?? []) as unknown as Creator[], total: count ?? 0 }
}

/** Live count only -- cheaper than fetching rows while the user drags a slider. */
export async function countCreators(filters: Filters): Promise<number> {
  let query = supabase.from('creators').select('id', { count: 'exact', head: true })
  query = applyFilters(query, filters)
  const { error, count } = await query
  if (error) throw new Error(describeError(error))
  return count ?? 0
}

/**
 * Distinct values for the filter controls, from a single RPC. Computing these in
 * the client would mean downloading every row just to build dropdowns.
 */
export async function fetchFilterOptions(): Promise<FilterOptions> {
  const { data, error } = await supabase.rpc('creators_filter_options')
  if (error) throw new Error(describeError(error))
  return data as FilterOptions
}

/** Every matching row, for CSV export. Paged to stay under PostgREST's cap. */
export async function fetchAllForExport(filters: Filters, cap = 5000): Promise<Creator[]> {
  const chunk = 1000
  const out: Creator[] = []
  for (let from = 0; from < cap; from += chunk) {
    let query = supabase
      .from('creators')
      .select(LIST_COLUMNS)
      .order('id', { ascending: true })
      .range(from, from + chunk - 1)
    query = applyFilters(query, filters)
    const { data, error } = await query
    if (error) throw new Error(describeError(error))
    const batch = (data ?? []) as unknown as Creator[]
    out.push(...batch)
    if (batch.length < chunk) break
  }
  return out
}


export interface FxRates {
  /** How many USD one unit of each currency is worth. */
  usdPerUnit: Record<string, number>
  asOf: string | null
}

/**
 * Conversion rates from the `fx_rates` table, so an upload converts fees exactly the
 * way the stored rows were converted. Refresh the table (see the root README) rather
 * than hardcoding rates here.
 */
export async function fetchFxRates(): Promise<FxRates> {
  const { data, error } = await supabase
    .from('fx_rates')
    .select('currency,usd_per_unit,as_of')
  if (error) throw new Error(describeError(error))
  const usdPerUnit: Record<string, number> = {}
  let asOf: string | null = null
  for (const r of data ?? []) {
    usdPerUnit[String(r.currency).toUpperCase()] = Number(r.usd_per_unit)
    if (!asOf || String(r.as_of) > asOf) asOf = String(r.as_of)
  }
  return { usdPerUnit, asOf }
}
