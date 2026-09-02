interface Props {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

const PAGE_SIZES = [25, 50, 100]

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: Props) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  const btn =
    'rounded-md border border-slate-200 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2.5">
      <p className="text-sm text-slate-600">
        {total === 0 ? 'No results' : (
          <>
            <span className="font-medium text-slate-900">{from.toLocaleString()}–{to.toLocaleString()}</span>
            {' of '}
            <span className="font-medium text-slate-900">{total.toLocaleString()}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          Per page
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-slate-400"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <button onClick={() => onPageChange(1)} disabled={page <= 1} className={btn}>«</button>
          <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className={btn}>Prev</button>
          <span className="px-2 text-sm tabular-nums text-slate-600">
            {page} / {pageCount}
          </span>
          <button onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} className={btn}>Next</button>
          <button onClick={() => onPageChange(pageCount)} disabled={page >= pageCount} className={btn}>»</button>
        </div>
      </div>
    </div>
  )
}
