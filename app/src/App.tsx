import { Suspense, lazy, useCallback, useMemo, useState } from 'react'
import { FilterPanel } from './components/FilterPanel'
import { Pagination } from './components/Pagination'
import { ResultsTable } from './components/ResultsTable'
import { ErrorState } from './components/ui'

// SheetJS is only needed once someone opens the uploader; keep it out of the
// initial bundle so the window paints fast.
const UploadModal = lazy(() =>
  import('./components/UploadModal').then((m) => ({ default: m.UploadModal })),
)
import { useCreators } from './hooks/useCreators'
import { useFilterOptions } from './hooks/useFilterOptions'
import { canSync, canWrite, configError, runSheetSync } from './lib/supabaseClient'
import type { SortKey } from './services/creatorsService'
import { EMPTY_FILTERS, type Filters } from './types'

/** How many filters are active, for the Clear button and the empty state. */
function countActive(f: Filters): number {
  let n = 0
  if (f.search.trim()) n++
  n += [f.categories, f.countries, f.languages, f.platforms, f.currencies, f.sourceSheets]
    .filter((a) => a.length > 0).length
  for (const r of [f.subscribers, f.followers, f.commercialsAmount]) {
    if (r.min !== null || r.max !== null) n++
  }
  if (f.onlyWithFee) n++
  return n
}

export default function App() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortKey, setSortKey] = useState<SortKey>('followers')
  const [sortAsc, setSortAsc] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  const options = useFilterOptions()
  const { rows, total, loading, error, reload } = useCreators({
    filters, page, pageSize, sortKey, sortAsc,
  })

  const activeCount = useMemo(() => countActive(filters), [filters])

  // Any filter change invalidates the current page number.
  const updateFilters = useCallback((next: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...next }))
    setPage(1)
  }, [])

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    setSyncNote(null)
    try {
      const r = await runSheetSync()
      setSyncNote(
        `Synced: ${r.rows_upserted ?? 0} rows, ${r.rows_deleted ?? 0} removed`,
      )
      void options.reload()
      reload()
    } catch (err) {
      setSyncNote(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
      // The note is transient feedback, not a persistent banner.
      setTimeout(() => setSyncNote(null), 6000)
    }
  }, [options, reload])

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortAsc((prevAsc) => (prevKey === key ? !prevAsc : false))
      return key
    })
    setPage(1)
  }, [])

  if (configError) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="max-w-lg rounded-lg border border-slate-200 bg-white p-6">
          <ErrorState
            title="Supabase is not configured"
            message={`${configError} Copy .env.example to .env, fill in your project details, and restart the app.`}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">Creators Explorer</h1>
          <span className="text-sm text-slate-500">
            {loading ? 'Searching…' : (
              <>
                <span className="font-medium text-slate-900 tabular-nums">{total.toLocaleString()}</span>
                {' matching'}
                {options.options.total_rows > 0 && (
                  <span className="text-slate-400">
                    {' '}of {options.options.total_rows.toLocaleString()}
                  </span>
                )}
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {syncNote && (
            <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
              {syncNote}
            </span>
          )}
          {canSync && (
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              title="Pull the Google Sheet now. It also syncs automatically on edit."
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
          {!canWrite && (
            <span className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800" title="Set VITE_SUPABASE_SERVICE_ROLE_KEY to enable uploads">
              read-only
            </span>
          )}
          <button
            onClick={() => setUploadOpen(true)}
            className="rounded-md bg-slate-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Upload sheet
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <FilterPanel
          filters={filters}
          options={options.options}
          loading={options.loading}
          activeCount={activeCount}
          onChange={updateFilters}
          onClear={clearFilters}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {options.error ? (
            <ErrorState
              title="Could not reach Supabase"
              message={options.error}
              onRetry={() => {
                void options.reload()
                reload()
              }}
            />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto bg-white">
                <ResultsTable
                  rows={rows}
                  loading={loading}
                  error={error}
                  sortKey={sortKey}
                  sortAsc={sortAsc}
                  onSort={handleSort}
                  onRetry={reload}
                  hasFilters={activeCount > 0}
                  onClearFilters={clearFilters}
                />
              </div>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size)
                  setPage(1)
                }}
              />
            </>
          )}
        </main>
      </div>

      {uploadOpen && (
        <Suspense fallback={null}>
          <UploadModal
            onClose={() => setUploadOpen(false)}
            onUploaded={() => {
              void options.reload()
              reload()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
