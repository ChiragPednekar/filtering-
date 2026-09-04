import { useState } from 'react'
import {
  canSync, updateCreator, type EditableField,
} from '../lib/supabaseClient'
import type { Creator } from '../types'

interface Props {
  creator: Creator
  onClose: () => void
  onSaved: () => void
}

/** Label, placeholder, and how to show the row's current value in the input. */
const FIELDS: {
  key: EditableField
  label: string
  placeholder?: string
  hint?: string
  value: (c: Creator) => string
}[] = [
  { key: 'mail', label: 'Email', value: (c) => c.mail ?? '' },
  {
    key: 'category', label: 'Category', hint: 'Separate with commas',
    value: (c) => (c.category ?? []).join(', '),
  },
  { key: 'country', label: 'Country', value: (c) => c.country ?? '' },
  { key: 'language', label: 'Language', value: (c) => c.language ?? '' },
  { key: 'platform', label: 'Platform', value: (c) => c.platform ?? '' },
  {
    key: 'followers', label: 'Followers', placeholder: '125.5k, 1.2M',
    value: (c) => (c.followers === null ? '' : String(c.followers)),
  },
  {
    key: 'subscribers', label: 'Subscribers', placeholder: '125.5k, 1.2M',
    value: (c) => (c.subscribers === null ? '' : String(c.subscribers)),
  },
  {
    key: 'commercials', label: 'Fee', placeholder: '$500, INR 25k, £400',
    hint: 'Any currency; converted to USD at the stored rate',
    value: (c) => c.commercials ?? '',
  },
  { key: 'deliverables', label: 'Deliverables', value: (c) => c.deliverables ?? '' },
]

const input =
  'w-full rounded-md border px-3 py-2 text-sm outline-none ' +
  'border-slate-200 focus:border-slate-400 dark:border-slate-700 dark:focus:border-slate-500'

/**
 * Editing one creator.
 *
 * Only the fields you change are saved, and each becomes an override: the sheet keeps
 * updating everything else, but stops overwriting what you edited. "Revert" drops an
 * override so that field follows the sheet again.
 */
export function EditCreatorModal({ creator, onClose, onSaved }: Props) {
  const overridden = new Set(Object.keys(creator.overrides ?? {}))
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, f.value(creator)])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty = FIELDS.filter((f) => form[f.key] !== f.value(creator))

  const save = async () => {
    if (!dirty.length) return
    setBusy(true)
    setError(null)
    try {
      const patch = Object.fromEntries(dirty.map((f) => [f.key, form[f.key]]))
      await updateCreator(creator.id, patch as Record<EditableField, string>)
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Drops the override so the sheet's value takes over again on the next sync. */
  const revert = async (field: EditableField) => {
    setBusy(true)
    setError(null)
    try {
      await updateCreator(creator.id, { [field]: null })
      setSaved(true)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6 dark:bg-black/70">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {creator.creator_name ?? creator.channel_link}
            </h2>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              {creator.brand} · {creator.source_sheet}
              {creator.manually_added ? ' · added by hand' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error}
            </div>
          )}

          {!canSync && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              Editing needs <code className="font-mono text-xs">VITE_SYNC_SECRET</code>. See DEPLOY.md.
            </div>
          )}

          {!creator.manually_added && (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
              This creator comes from a sheet that syncs every minute. A field you edit
              here stops following the sheet; everything you leave alone keeps updating
              from it. <strong>Revert</strong> hands a field back to the sheet — its old
              value returns on the next sync, usually within a minute.
            </p>
          )}

          {saved && !dirty.length && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
              Saved. This will not be overwritten by the sync.
            </div>
          )}

          {FIELDS.map((f) => {
            const isOverridden = overridden.has(f.key)
            const isDirty = form[f.key] !== f.value(creator)
            return (
              <div key={f.key}>
                <div className="mb-1.5 flex items-center gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {f.label}
                  </label>
                  {isOverridden && (
                    <>
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        edited
                      </span>
                      <button
                        onClick={() => void revert(f.key)}
                        disabled={busy}
                        title="Drop this edit. The sheet's value returns on the next sync, within a minute."
                        className="text-[10px] text-slate-500 underline hover:text-slate-900 disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-100"
                      >
                        revert
                      </button>
                    </>
                  )}
                  {isDirty && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">unsaved</span>
                  )}
                </div>
                <input
                  className={input}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => {
                    setSaved(false)
                    setForm((s) => ({ ...s, [f.key]: e.target.value }))
                  }}
                />
                {f.hint && <p className="mt-1 text-xs text-slate-400">{f.hint}</p>}
              </div>
            )
          })}

          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Profile link
            </span>
            <a
              href={creator.channel_link}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 block break-all text-sm text-blue-700 hover:underline dark:text-blue-400"
            >
              {creator.channel_link}
            </a>
            <p className="mt-1 text-xs text-slate-400">
              The link is part of this row&apos;s identity, so it cannot be edited. Add a
              new creator instead if the profile has moved.
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 px-5 py-3 dark:border-slate-700">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Close
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !canSync || !dirty.length}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {busy ? 'Saving…' : dirty.length ? `Save ${dirty.length} change${dirty.length > 1 ? 's' : ''}` : 'No changes'}
          </button>
        </footer>
      </div>
    </div>
  )
}
