import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  autoMapHeaders, mapRows, parseFile, upsertRows,
  type MapResult, type ParsedWorkbook, type UploadSummary,
} from '../services/uploadService'
import { canSync, canWrite, fetchSheetSources, registerSheet,
  type SheetSource } from '../lib/supabaseClient'
import { fetchFxRates, type FxRates } from '../services/creatorsService'
import { CANONICAL_FIELDS, type CanonicalField } from '../types'
import { formatMoney } from './ui'

type Step = 'pick' | 'map' | 'preview' | 'done'
type Mode = 'connect' | 'file'

interface Props {
  onClose: () => void
  onUploaded: () => void
}

export function UploadModal({ onClose, onUploaded }: Props) {
  const [step, setStep] = useState<Step>('pick')
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState<Record<number, CanonicalField | ''>>({})
  const [sourceName, setSourceName] = useState('')
  const [mapped, setMapped] = useState<MapResult | null>(null)
  const [summary, setSummary] = useState<UploadSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fx, setFx] = useState<FxRates | null>(null)
  // Connecting a sheet is the default: a linked sheet keeps syncing, an uploaded file
  // is a snapshot that goes stale the moment someone edits the original.
  const [mode, setMode] = useState<Mode>('connect')
  const [sheetUrl, setSheetUrl] = useState('')
  const [brand, setBrand] = useState('')
  const [sources, setSources] = useState<SheetSource[]>([])
  const [connected, setConnected] = useState<string | null>(null)

  useEffect(() => {
    fetchSheetSources().then(setSources).catch(() => setSources([]))
  }, [connected])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await registerSheet(sheetUrl.trim(), brand.trim())
      const first = r.first_sync
      if (first?.status === 'error') {
        throw new Error(`Connected, but the first sync failed: ${first.error}`)
      }
      setConnected(`${r.registered} — ${first?.rows_upserted?.toLocaleString() ?? 0} creators imported`)
      setSheetUrl('')
      setBrand('')
      onUploaded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sheet = workbook?.sheets[sheetIndex] ?? null

  const selectSheet = useCallback((wb: ParsedWorkbook, index: number) => {
    const s = wb.sheets[index]
    setSheetIndex(index)
    setMapping(autoMapHeaders(s.headers))
    setSourceName(s.name)
  }, [])

  const handleFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const wb = await parseFile(file)
      if (!wb.sheets.length) throw new Error('No readable sheets found in that file.')
      setWorkbook(wb)
      selectSheet(wb, 0)
      setStep('map')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const linkColumnChosen = useMemo(
    () => Object.values(mapping).includes('channel_link'),
    [mapping],
  )

  const buildPreview = async () => {
    if (!sheet) return
    setBusy(true)
    setError(null)
    try {
      // Same rates the stored rows were converted with, so an upload stays consistent.
      const rates = fx ?? (await fetchFxRates())
      if (!fx) setFx(rates)
      const result = await mapRows(sheet, mapping, sourceName.trim() || sheet.name, rates)
      if (!result.rows.length) {
        throw new Error(
          'No rows survived mapping. Check that the link column is mapped correctly.',
        )
      }
      setMapped(result)
      setStep('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!mapped) return
    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: mapped.rows.length })
    try {
      const result = await upsertRows(mapped.rows, (done, total) => setProgress({ done, total }))
      setSummary(result)
      setStep('done')
      onUploaded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 dark:bg-black/70 p-6">
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-lg bg-white dark:bg-slate-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add a sheet</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {step === 'pick' && (mode === 'connect'
                ? 'Connect a Google Sheet that keeps syncing'
                : 'Import a spreadsheet file once')}
              {step === 'map' && 'Confirm how columns map to the schema'}
              {step === 'preview' && 'Review the cleaned rows before committing'}
              {step === 'done' && 'Upload complete'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-800 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Only relevant to the file path: connecting a sheet uses VITE_SYNC_SECRET,
              which is a different key, so showing this in connect mode reads as though
              connecting were blocked when it is not. */}
          {!canWrite && step !== 'done' && mode === 'file' && (
            <div className="mb-4 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">
              Read-only mode: <code className="font-mono text-xs">VITE_SUPABASE_SERVICE_ROLE_KEY</code> is
              not set, so uploads are disabled. You can still map and preview a file.
            </div>
          )}

          {step === 'pick' && (
            <div className="space-y-4">
              <div className="flex gap-1 rounded-md bg-slate-100 dark:bg-slate-800 p-0.5">
                {([['connect', 'Connect a Google Sheet'], ['file', 'Import a file once']] as [Mode, string][])
                  .map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => { setMode(value); setError(null) }}
                      className={`flex-1 rounded px-3 py-1.5 text-sm font-medium ${
                        mode === value
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
              </div>

              {mode === 'connect' ? (
                <div className="space-y-3">
                  {!canSync && (
                    <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">
                      Connecting a sheet needs <code className="font-mono text-xs">VITE_SYNC_SECRET</code>.
                      See DEPLOY.md.
                    </div>
                  )}
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    A connected sheet keeps syncing every minute, so edits your team makes
                    in Google Sheets reach the database on their own. Importing a file
                    instead gives you a snapshot that goes stale the moment someone edits
                    the original.
                  </p>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Google Sheet link
                    </label>
                    <input
                      value={sheetUrl}
                      onChange={(e) => setSheetUrl(e.target.value)}
                      placeholder="https://docs.google.com/spreadsheets/d/..."
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:focus:border-slate-500"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Brand name
                    </label>
                    <input
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      placeholder="e.g. Acme"
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:focus:border-slate-500"
                    />
                    <p className="mt-1 text-xs text-slate-400">
                      Keeps each brand&apos;s creators separate. Two sheets both containing a
                      tab called &quot;Sheet2&quot; would otherwise overwrite each other.
                    </p>
                  </div>

                  <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-900 dark:text-amber-300">
                    The sheet must be shared as <strong>Anyone with the link → Viewer</strong>,
                    otherwise the sync cannot read it. It is checked before anything is saved.
                  </div>

                  {connected && (
                    <div className="rounded-md border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950 px-3 py-2 text-sm text-green-800 dark:text-green-300">
                      Connected: {connected}
                    </div>
                  )}

                  {sources.length > 0 && (
                    <div className="rounded-md border border-slate-200 dark:border-slate-700">
                      <div className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Connected sheets ({sources.length})
                      </div>
                      <div className="max-h-40 overflow-y-auto">
                        {sources.map((s) => (
                          <div key={s.brand} className="flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 px-3 py-2 text-sm last:border-0">
                            <div className="min-w-0">
                              <a href={s.sheet_url} target="_blank" rel="noreferrer noopener"
                                 className="font-medium text-blue-700 dark:text-blue-400 hover:underline">
                                {s.brand}
                              </a>
                              <div className="truncate text-xs text-slate-400" title={s.last_error ?? ''}>
                                {s.last_status === 'error'
                                  ? `last sync failed: ${s.last_error}`
                                  : `${s.last_rows?.toLocaleString() ?? 0} creators · last synced ${
                                      s.last_run_at ? new Date(s.last_run_at).toLocaleTimeString() : 'never'}`}
                              </div>
                            </div>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                              s.last_status === 'error'
                                ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                            }`}>
                              {s.enabled ? (s.last_status ?? 'pending') : 'paused'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 py-14 hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {busy ? 'Reading file...' : 'Click to choose a file'}
                  </span>
                  <span className="text-xs text-slate-400">
                    .xlsx, .xls or .csv — parsed on this machine, imported once
                  </span>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void handleFile(f)
                    }}
                  />
                </label>
              )}
            </div>
          )}

          {step === 'map' && sheet && workbook && (
            <div className="space-y-4">
              {workbook.sheets.length > 1 && (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Tab
                  </label>
                  <select
                    value={sheetIndex}
                    onChange={(e) => selectSheet(workbook, Number(e.target.value))}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:focus:border-slate-500"
                  >
                    {workbook.sheets.map((s, i) => (
                      <option key={s.name} value={i}>{s.name} ({s.rows.length} rows)</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Source sheet name
                </label>
                <input
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:focus:border-slate-500"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Stored as <code className="font-mono">source_sheet</code> and part of the upsert key.
                  Re-uploading with this same name updates those rows instead of duplicating them.
                </p>
              </div>

              <div className="rounded-md border border-slate-200 dark:border-slate-700">
                <div className="grid grid-cols-[1fr_1fr_2fr] gap-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <span>Column in file</span>
                  <span>Maps to</span>
                  <span>First value</span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {sheet.headers.map((header, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_2fr] items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-3 py-2 last:border-0">
                      <span className="truncate text-sm text-slate-800 dark:text-slate-200" title={header}>
                        {header || <em className="text-slate-400">(unnamed)</em>}
                      </span>
                      <select
                        value={mapping[i] ?? ''}
                        onChange={(e) =>
                          setMapping({ ...mapping, [i]: e.target.value as CanonicalField | '' })
                        }
                        className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-sm outline-none focus:border-slate-400 dark:focus:border-slate-500"
                      >
                        <option value="">— ignore —</option>
                        {CANONICAL_FIELDS.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                      <span className="truncate text-xs text-slate-400" title={sheet.rows[0]?.[i]}>
                        {sheet.rows[0]?.[i] || '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {!linkColumnChosen && (
                <p className="text-sm text-amber-700">
                  Map one column to <strong>Channel / Profile link</strong> — it is the key every row needs.
                </p>
              )}
            </div>
          )}

          {step === 'preview' && mapped && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3">
                {[
                  ['Ready to upsert', mapped.rows.length],
                  ['Skipped, no URL', mapped.skippedNoUrl],
                  ['Exact duplicates merged', mapped.exactDuplicates],
                  ['Header/blank rows dropped', mapped.droppedRows],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
                    <p className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value as number}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{label as string}</p>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <tr>
                      {['Channel', 'Category', 'Country', 'Platform', 'Audience', 'Fee (USD)', 'Quoted'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {mapped.rows.slice(0, 12).map((r, i) => (
                      <tr key={i}>
                        <td className="max-w-[240px] truncate px-3 py-2 text-blue-700 dark:text-blue-400" title={r.channel_link}>
                          {r.channel_link.replace(/^https?:\/\//, '')}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.category.join(', ') || '—'}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.country ?? '—'}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.platform ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                          {(r.followers ?? r.subscribers)?.toLocaleString() ?? '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-900 dark:text-slate-100">
                          {formatMoney(r.commercials_amount, 'USD')}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                          {r.commercials_currency_native && r.commercials_currency_native !== 'USD'
                            ? formatMoney(r.commercials_amount_native, r.commercials_currency_native)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mapped.rows.length > 12 && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Showing the first 12 of {mapped.rows.length.toLocaleString()} rows.
                </p>
              )}

              {progress && (
                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className="h-full bg-slate-900 dark:bg-slate-100 transition-all"
                      style={{ width: `${(progress.done / progress.total) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Upserting {progress.done.toLocaleString()} of {progress.total.toLocaleString()}...
                  </p>
                </div>
              )}
            </div>
          )}

          {step === 'done' && summary && (
            <div className="py-8 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-green-50 dark:bg-green-950 text-xl text-green-600 dark:text-green-400">
                ✓
              </div>
              <p className="font-medium text-slate-900 dark:text-slate-100">Upload complete</p>
              <div className="mt-4 flex justify-center gap-3">
                {[
                  ['New creators added', summary.inserted],
                  ['Existing creators updated', summary.updated],
                  ['Total processed', summary.total],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-md border border-slate-200 dark:border-slate-700 px-4 py-3">
                    <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value as number}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{label as string}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 dark:border-slate-700 px-5 py-3">
          <button
            onClick={() => {
              if (step === 'preview') setStep('map')
              else if (step === 'map') setStep('pick')
              else onClose()
            }}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {step === 'pick' || step === 'done' ? 'Close' : 'Back'}
          </button>

          {step === 'pick' && mode === 'connect' && (
            <button
              onClick={() => void connect()}
              disabled={busy || !canSync || !sheetUrl.trim() || !brand.trim()}
              title={canSync ? undefined : 'Connecting a sheet needs VITE_SYNC_SECRET'}
              className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-sm font-medium text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-white disabled:opacity-40"
            >
              {busy ? 'Connecting\u2026' : 'Connect sheet'}
            </button>
          )}

          {step === 'map' && (
            <button
              onClick={buildPreview}
              disabled={busy || !linkColumnChosen}
              className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-sm font-medium text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-white disabled:opacity-40"
            >
              {busy ? 'Mapping...' : 'Preview'}
            </button>
          )}

          {step === 'preview' && (
            <button
              onClick={commit}
              disabled={busy || !canWrite}
              className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-sm font-medium text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-white disabled:opacity-40"
              title={canWrite ? undefined : 'Service role key required'}
            >
              {busy ? 'Uploading...' : `Upsert ${mapped?.rows.length.toLocaleString()} rows`}
            </button>
          )}

          {step === 'done' && (
            <button
              onClick={onClose}
              className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-sm font-medium text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-white"
            >
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
