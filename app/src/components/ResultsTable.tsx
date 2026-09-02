import type { SortKey } from '../services/creatorsService'
import type { Creator } from '../types'
import { EmptyState, ErrorState, TableSkeleton, formatMoney, formatNumber } from './ui'

interface Props {
  rows: Creator[]
  loading: boolean
  error: string | null
  sortKey: SortKey
  sortAsc: boolean
  onSort: (key: SortKey) => void
  onRetry: () => void
  hasFilters: boolean
  onClearFilters: () => void
}

const COLUMNS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: 'creator_name', label: 'Creator', className: 'min-w-[240px]' },
  { key: null, label: 'Category', className: 'min-w-[180px]' },
  { key: 'country', label: 'Country' },
  { key: 'platform', label: 'Platform' },
  { key: 'followers', label: 'Audience', className: 'text-right' },
  { key: 'commercials_amount', label: 'Fee (USD)', className: 'text-right' },
  { key: null, label: 'Quoted as', className: 'min-w-[130px]' },
  { key: null, label: 'Deliverables', className: 'min-w-[200px]' },
]

/** Strip the scheme so the table shows the handle, not boilerplate. */
const displayLink = (url: string) => url.replace(/^https?:\/\//, '')

export function ResultsTable({
  rows, loading, error, sortKey, sortAsc, onSort, onRetry, hasFilters, onClearFilters,
}: Props) {
  if (error) {
    return <ErrorState title="Could not load creators" message={error} onRetry={onRetry} />
  }

  if (loading) return <TableSkeleton rows={10} cols={7} />

  if (!rows.length) {
    return (
      <EmptyState
        title={hasFilters ? 'No creators match these filters' : 'No creators yet'}
        message={
          hasFilters
            ? 'Try widening a range or removing a filter.'
            : 'The table is empty. Upload a sheet to add creators.'
        }
        action={
          hasFilters ? (
            <button
              onClick={onClearFilters}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Clear filters
            </button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50">
          <tr className="border-b border-slate-200">
            {COLUMNS.map((col) => (
              <th
                key={col.label}
                className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${col.className ?? ''}`}
              >
                {col.key ? (
                  <button
                    onClick={() => onSort(col.key!)}
                    className="inline-flex items-center gap-1 hover:text-slate-900"
                  >
                    {col.label}
                    <span className={sortKey === col.key ? 'text-slate-900' : 'text-slate-300'}>
                      {sortKey === col.key ? (sortAsc ? '↑' : '↓') : '↕'}
                    </span>
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const audience = row.followers ?? row.subscribers
            const audienceLabel = row.followers !== null ? 'followers' : row.subscribers !== null ? 'subs' : ''
            return (
              <tr key={row.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <a
                    href={row.channel_link}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-medium text-blue-700 hover:underline"
                    title={row.channel_link}
                  >
                    {row.creator_name ?? displayLink(row.channel_link)}
                  </a>
                  <div className="truncate text-xs text-slate-400" title={row.channel_link}>
                    {row.mail ?? displayLink(row.channel_link)}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {(row.category ?? []).slice(0, 3).map((c) => (
                      <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                        {c}
                      </span>
                    ))}
                    {(row.category?.length ?? 0) > 3 && (
                      <span
                        className="text-xs text-slate-400"
                        title={(row.category ?? []).slice(3).join(', ')}
                      >
                        +{(row.category?.length ?? 0) - 3}
                      </span>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-700">{row.country ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-700">{row.platform ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-900">
                  {formatNumber(audience)}
                  {audienceLabel && <span className="ml-1 text-xs text-slate-400">{audienceLabel}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums font-medium text-slate-900">
                  {formatMoney(row.commercials_amount, 'USD')}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500" title={row.commercials ?? ''}>
                  {row.commercials_currency_native &&
                  row.commercials_currency_native !== 'USD' ? (
                    <span className="whitespace-nowrap">
                      {formatMoney(row.commercials_amount_native, row.commercials_currency_native)}
                      <span className="ml-1 text-slate-400">
                        {row.commercials_currency_native}
                      </span>
                    </span>
                  ) : (
                    <span className="line-clamp-2">{row.commercials ?? '—'}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500" title={row.deliverables ?? ''}>
                  <span className="line-clamp-2">{row.deliverables ?? '—'}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
