import { useState, type ReactNode } from 'react'

/** Grey block used while a query is in flight. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200 ${className}`} />
}

export function TableSkeleton({ rows = 8, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? 'w-64' : 'w-24'}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function FilterSkeleton() {
  return (
    <div className="space-y-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-xl text-red-600">
        !
      </div>
      <div>
        <p className="font-medium text-slate-900">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{message}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      <p className="max-w-md text-sm text-slate-600">{message}</p>
      {action}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  )
}

export interface SelectOption {
  value: string
  label: string
  count?: number
}

/** Accepts plain strings or {value,label} pairs. */
export const toOptions = (items: (string | SelectOption)[]): SelectOption[] =>
  items.map((i) => (typeof i === 'string' ? { value: i, label: i } : i))

/**
 * Checkbox list used for every multi-value filter. A native <select multiple> is
 * unusable with hundreds of options, and this keeps selections visible.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Search...',
  maxHeight = 'max-h-44',
}: {
  options: (string | SelectOption)[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  maxHeight?: string
}) {
  const opts = toOptions(options)
  const [term, setTerm] = useState('')

  // Select-all acts on what is currently visible, so filtering the list then hitting
  // "All" selects that subset rather than silently selecting hundreds of hidden values.
  const visible = term
    ? opts.filter((o) => o.label.toLowerCase().includes(term.toLowerCase()))
    : opts
  const visibleValues = visible.map((o) => o.value)
  const allVisibleSelected =
    visibleValues.length > 0 && visibleValues.every((v) => selected.includes(v))

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  const selectAllVisible = () =>
    onChange([...new Set([...selected, ...visibleValues])])

  const clearVisible = () =>
    onChange(selected.filter((v) => !visibleValues.includes(v)))

  if (!opts.length) {
    return (
      <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
        No values yet
      </p>
    )
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      {opts.length > 8 && (
        <input
          type="search"
          value={term}
          placeholder={placeholder}
          onChange={(e) => setTerm(e.target.value)}
          className="w-full rounded-t-md border-b border-slate-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-slate-50"
        />
      )}

      <div className="flex items-center justify-between border-b border-slate-100 px-2 py-1">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => {
              if (el) {
                // Indeterminate when only some of the visible options are selected.
                el.indeterminate =
                  !allVisibleSelected && visibleValues.some((v) => selected.includes(v))
              }
            }}
            onChange={() => (allVisibleSelected ? clearVisible() : selectAllVisible())}
            className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900"
          />
          {allVisibleSelected ? 'Deselect all' : 'Select all'}
          {term && <span className="text-slate-400">({visible.length} shown)</span>}
        </label>
        {selected.length > 0 && (
          <span className="text-xs tabular-nums text-slate-400">{selected.length}</span>
        )}
      </div>

      <div className={`${maxHeight} overflow-y-auto p-1`}>
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-slate-400">No matches</p>
        ) : (
          visible.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900"
              />
              <span className="min-w-0 flex-1 truncate text-slate-700" title={opt.label}>
                {opt.label}
              </span>
              {opt.count !== undefined && (
                <span className="shrink-0 text-xs tabular-nums text-slate-400">{opt.count}</span>
              )}
            </label>
          ))
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5">
          <span className="text-xs text-slate-500">{selected.length} selected</span>
          <button onClick={() => onChange([])} className="text-xs text-slate-500 underline hover:text-slate-900">
            clear all
          </button>
        </div>
      )}
    </div>
  )
}

export function RangeInput({
  value,
  onChange,
  bounds,
  step = 1,
}: {
  value: { min: number | null; max: number | null }
  onChange: (next: { min: number | null; max: number | null }) => void
  bounds: { min: number; max: number }
  step?: number
}) {
  const parse = (raw: string) => (raw.trim() === '' ? null : Number(raw))
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        step={step}
        placeholder={`min ${bounds.min.toLocaleString()}`}
        value={value.min ?? ''}
        onChange={(e) => onChange({ ...value, min: parse(e.target.value) })}
        className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />
      <span className="text-xs text-slate-400">to</span>
      <input
        type="number"
        step={step}
        placeholder={`max ${bounds.max.toLocaleString()}`}
        value={value.max ?? ''}
        onChange={(e) => onChange({ ...value, max: parse(e.target.value) })}
        className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />
    </div>
  )
}

export const formatNumber = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString()

export function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${currency ?? ''} ${amount.toLocaleString()}`.trim()
  }
}
