import { useCallback, useEffect, useState } from 'react'
import { fetchFilterOptions } from '../services/creatorsService'
import type { FilterOptions } from '../types'

const EMPTY: FilterOptions = {
  categories: [], brands: [], countries: [], languages: [], platforms: [],
  currencies: [], source_sheets: [],
  ranges: {
    subscribers: { min: 0, max: 0 },
    followers: { min: 0, max: 0 },
    commercials_amount: { min: 0, max: 0 },
  },
  fx: { as_of: null, source: null },
  total_rows: 0,
}

/**
 * Distinct values for the filter controls. Loaded once and refreshed after an
 * upload, since a new sheet can introduce categories or countries not seen before.
 */
export function useFilterOptions() {
  const [options, setOptions] = useState<FilterOptions>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setOptions(await fetchFilterOptions())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { options, loading, error, reload: load }
}
