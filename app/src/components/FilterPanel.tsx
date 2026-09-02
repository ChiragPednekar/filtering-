import { Field, FilterSkeleton, MultiSelect, RangeInput } from './ui'
import type { FilterOptions, Filters } from '../types'

interface Props {
  filters: Filters
  options: FilterOptions
  loading: boolean
  activeCount: number
  onChange: (next: Partial<Filters>) => void
  onClear: () => void
}

export function FilterPanel({ filters, options, loading, activeCount, onChange, onClear }: Props) {
  const { ranges } = options

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Filters</h2>
        <button
          onClick={onClear}
          disabled={activeCount === 0}
          className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear{activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {loading ? (
          <FilterSkeleton />
        ) : (
          <>
            <Field label="Search" hint="Creator name, link, email, deliverables or fee text">
              <input
                type="search"
                value={filters.search}
                onChange={(e) => onChange({ search: e.target.value })}
                placeholder="Search creators by name..."
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-slate-400"
              />
            </Field>

            <Field
              label="Category"
              hint={filters.categoryMode === 'any' ? 'Matches any selected category' : 'Must have every selected category'}
            >
              <div className="mb-1.5 flex gap-1">
                {(['any', 'all'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => onChange({ categoryMode: mode })}
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      filters.categoryMode === mode
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {mode === 'any' ? 'Any of' : 'All of'}
                  </button>
                ))}
              </div>
              <MultiSelect
                options={options.categories}
                selected={filters.categories}
                onChange={(categories) => onChange({ categories })}
                placeholder="Search categories..."
              />
            </Field>

            <Field label="Platform">
              <MultiSelect
                options={options.platforms}
                selected={filters.platforms}
                onChange={(platforms) => onChange({ platforms })}
              />
            </Field>

            <Field label="Country">
              <MultiSelect
                options={options.countries}
                selected={filters.countries}
                onChange={(countries) => onChange({ countries })}
                placeholder="Search countries..."
              />
            </Field>

            <Field label="Language">
              <MultiSelect
                options={options.languages}
                selected={filters.languages}
                onChange={(languages) => onChange({ languages })}
                placeholder="Search languages..."
              />
            </Field>

            <Field label="Subscribers" hint="YouTube channels">
              <RangeInput
                value={filters.subscribers}
                onChange={(subscribers) => onChange({ subscribers })}
                bounds={ranges.subscribers}
              />
            </Field>

            <Field label="Followers" hint="Instagram / TikTok">
              <RangeInput
                value={filters.followers}
                onChange={(followers) => onChange({ followers })}
                bounds={ranges.followers}
              />
            </Field>

            <Field
              label="Fee (USD)"
              hint={`All fees converted to USD${
                options.fx?.as_of ? ` at ${options.fx.as_of} rates` : ''
              }. Lowest price where a cell lists several.`}
            >
              <RangeInput
                value={filters.commercialsAmount}
                onChange={(commercialsAmount) => onChange({ commercialsAmount })}
                bounds={ranges.commercials_amount}
              />
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={filters.onlyWithFee}
                  onChange={(e) => onChange({ onlyWithFee: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900"
                />
                Only rows with a parsed fee
              </label>
            </Field>

            <Field label="Quoted currency" hint="The currency the fee was quoted in">
              <MultiSelect
                options={options.currencies}
                selected={filters.currencies}
                onChange={(currencies) => onChange({ currencies })}
                maxHeight="max-h-32"
              />
            </Field>

            <Field label="Source sheet">
              <MultiSelect
                options={options.source_sheets}
                selected={filters.sourceSheets}
                onChange={(sourceSheets) => onChange({ sourceSheets })}
                maxHeight="max-h-32"
              />
            </Field>
          </>
        )}
      </div>
    </aside>
  )
}
