import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchCreators, type SortKey } from '../services/creatorsService'
import type { Creator, Filters } from '../types'

interface Args {
  filters: Filters
  page: number
  pageSize: number
  sortKey: SortKey
  sortAsc: boolean
}

/**
 * Fetches one page of results for the current filters.
 *
 * Requests are debounced (typing in the search box or dragging a range input would
 * otherwise fire a query per keystroke) and stale responses are discarded, so a slow
 * early request can never overwrite the results of a later one.
 */
export function useCreators({ filters, page, pageSize, sortKey, sortAsc }: Args) {
  const [rows, setRows] = useState<Creator[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)

    const timer = setTimeout(async () => {
      try {
        const result = await fetchCreators({ filters, page, pageSize, sortKey, sortAsc })
        if (id !== requestId.current) return // a newer request has superseded this one
        setRows(result.rows)
        setTotal(result.total)
      } catch (err) {
        if (id !== requestId.current) return
        setError(err instanceof Error ? err.message : String(err))
        setRows([])
        setTotal(0)
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [filters, page, pageSize, sortKey, sortAsc, reloadToken])

  return { rows, total, loading, error, reload }
}
