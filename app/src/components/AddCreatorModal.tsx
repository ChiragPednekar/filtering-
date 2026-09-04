import { useState } from 'react'
import { addCreator, canSync, type AddCreatorResult, type NewCreator } from '../lib/supabaseClient'

interface Props {
  brands: string[]
  onClose: () => void
  onAdded: () => void
}

const EMPTY: NewCreator = {
  channel_link: '', brand: '', mail: '', category: '',
  country: '', language: '', audience: '', commercials: '', deliverables: '',
}

const input =
  'w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none ' +
  'focus:border-slate-400 dark:border-slate-700 dark:focus:border-slate-500'

const label =
  'mb-1.5 block text-xs font-semibold uppercase tracking-wide ' +
  'text-slate-500 dark:text-slate-400'

/**
 * Adding one creator by hand, for the ones that never make it into a sheet.
 *
 * Values are cleaned server-side by the same code that reads a sheet, so messy input
 * is fine: "125.5k" becomes 125,500 and "INR 25k" becomes ₹25,000 converted to USD.
 * Nothing here needs to be pre-formatted.
 */
export function AddCreatorModal({ brands, onClose, onAdded }: Props) {
  const [form, setForm] = useState<NewCreator>({ ...EMPTY, brand: brands[0] ?? 'Manual' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<AddCreatorResult['creator'] | null>(null)

  const set = (k: keyof NewCreator) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await addCreator({ ...form, channel_link: form.channel_link.trim() })
      setAdded(r.creator ?? null)
      onAdded()
      // Keep the brand so adding several in a row does not mean re-picking it.
      setForm({ ...EMPTY, brand: form.brand })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6 dark:bg-black/70">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add a creator</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              For creators that are not in any connected sheet
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
              Adding a creator needs <code className="font-mono text-xs">VITE_SYNC_SECRET</code>. See DEPLOY.md.
            </div>
          )}

          {added && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
              Added <strong>{added.channel_link.replace(/^https?:\/\//, '')}</strong>
              {added.platform ? ` · ${added.platform}` : ''}
              {added.followers !== null ? ` · ${added.followers.toLocaleString()} followers` : ''}
              {added.subscribers !== null ? ` · ${added.subscribers.toLocaleString()} subscribers` : ''}
              {added.fee_usd !== null ? ` · $${added.fee_usd.toLocaleString()}` : ''}
              {added.quoted && !added.quoted.startsWith(String(added.fee_usd))
                ? ` (quoted ${added.quoted})` : ''}
            </div>
          )}

          <div>
            <label className={label}>Profile or channel URL *</label>
            <input
              className={input}
              value={form.channel_link}
              onChange={set('channel_link')}
              placeholder="https://www.instagram.com/theirhandle"
            />
            <p className="mt-1 text-xs text-slate-400">
              The platform is worked out from the link, and tracking parameters are stripped.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Brand</label>
              <input
                className={input}
                list="known-brands"
                value={form.brand}
                onChange={set('brand')}
                placeholder="Manual"
              />
              <datalist id="known-brands">
                {brands.map((b) => <option key={b} value={b} />)}
              </datalist>
              <p className="mt-1 text-xs text-slate-400">
                Safe to file under a synced brand — hand-added creators are never
                removed by a sheet sync.
              </p>
            </div>
            <div>
              <label className={label}>Email</label>
              <input className={input} value={form.mail} onChange={set('mail')}
                     placeholder="name@example.com" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Followers / subscribers</label>
              <input className={input} value={form.audience} onChange={set('audience')}
                     placeholder="125.5k, 1.2M, 40.3L" />
            </div>
            <div>
              <label className={label}>Fee</label>
              <input className={input} value={form.commercials} onChange={set('commercials')}
                     placeholder="$500, INR 25k, £400, €450" />
              <p className="mt-1 text-xs text-slate-400">
                Any currency. It is converted to USD at the stored rates.
              </p>
            </div>
          </div>

          <div>
            <label className={label}>Category</label>
            <input className={input} value={form.category} onChange={set('category')}
                   placeholder="Tech, AI tools" />
            <p className="mt-1 text-xs text-slate-400">Separate with commas.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Country</label>
              <input className={input} value={form.country} onChange={set('country')} placeholder="US" />
            </div>
            <div>
              <label className={label}>Language</label>
              <input className={input} value={form.language} onChange={set('language')} placeholder="English" />
            </div>
          </div>

          <div>
            <label className={label}>Deliverables</label>
            <input className={input} value={form.deliverables} onChange={set('deliverables')}
                   placeholder="1 IG Reel + link in bio for 7 days" />
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
            onClick={() => void submit()}
            disabled={busy || !canSync || !form.channel_link.trim()}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {busy ? 'Adding…' : 'Add creator'}
          </button>
        </footer>
      </div>
    </div>
  )
}
