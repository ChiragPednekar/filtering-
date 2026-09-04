# Creators Explorer

Internal Electron + React desktop app for filtering the `creators` table and uploading
new sheets into it.

```bash
npm install
cp .env.example .env      # fill in your project details
npm run dev               # Vite + Electron
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Electron window |
| `npm run dev:web` | Browser only, no Electron — handy for quick UI work |
| `npm start` | Production build, then Electron |
| `npm run dist` | Package a distributable via electron-builder |
| `npm run test:upload` | Runs the upload pipeline against the real workbook |

## Configuration

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_xxx
VITE_SUPABASE_SERVICE_ROLE_KEY=          # only needed for uploads
```

**Reads** use the publishable key. RLS allows it `SELECT` on `creators` and nothing
else — it cannot insert, update or delete, so it is safe in the bundle.

**Uploads** need the service role key, which bypasses RLS entirely. Anyone with the
packaged `.app` can extract it, so treat the build as trusted-internal-only. Leave the
variable empty and the app runs read-only: the header shows a `read-only` badge and the
upload dialog explains why the commit button is disabled. Nothing crashes.

To move the key out of the bundle later, hold it in the Electron main process and
proxy writes over IPC, or switch to Supabase Auth with per-user policies.

## Upload: parsed in the frontend — and why

**Recommendation: parse in the renderer with SheetJS. No backend.** Implemented that way.

- There is no server in this stack. Adding one to parse spreadsheets means something to
  deploy, secure, and keep running, for a tool used by a handful of people.
- The files are small. The entire source workbook is ~250 KB / 1,363 rows; SheetJS
  handles that instantly. Server-side parsing earns its keep at hundreds of MB, not here.
- The file never leaves the machine. Nothing is uploaded except the cleaned rows.
- The mapping UI needs the parsed columns anyway to show a preview and let you correct
  the mapping. Parsing locally makes that a function call rather than a round trip.
- SheetJS is code-split, so it only loads when the dialog opens (~350 KB, not in the
  initial bundle).

Switch to a backend if files ever reach tens of MB, if you want uploads to run
unattended on a schedule, or if you need the service role key off client machines —
that last one is the strongest argument, and it is a security decision, not a
performance one.

## Upload flow

1. **Pick** an `.xlsx`, `.xls` or `.csv`.
2. **Map** — each column in the file gets a dropdown to a canonical field. Headers are
   auto-matched (`Email ID` → mail, `Followers` → audience, `Commercials ( $ )` → fee)
   and you can override any of them. You also name the **source sheet**, which becomes
   `source_sheet` and is part of the upsert key.
3. **Preview** — shows rows ready to upsert, rows skipped for having no URL, exact
   duplicates merged, and header/blank rows dropped, plus the first 12 cleaned rows.
4. **Commit** — upserts in batches of 250 and reports **X new / Y updated**.

Re-uploading a sheet under the same source name updates those rows in place instead of
duplicating them.

### Why the conflict key is not `channel_link` alone

There is no unique constraint on `channel_link`, so `ON CONFLICT (channel_link)` would
error. One creator legitimately appears in several sheets with different negotiated
fees — `@timexplainsai` is $700 in Sheet2 and $800 in Sheet7 — and sometimes twice in
one sheet with different deliverable packages. The key is
`(channel_link, source_sheet, variant_no)`:

- `channel_link` is normalised (`https://host/path`, lowercase host, no `www.`, no
  trailing `?`), so `.../iharnoor?` and `.../iharnoor` are the same creator.
- `variant_no` separates genuine variants within one sheet. It is assigned from a
  content hash, so re-uploading a reordered sheet still maps each row to the same record.
- Byte-identical repeats are collapsed before upload.

## Currency lives in the cell format

Some fee cells hold a plain number whose currency is only in the Excel **number
format** — `3500` displayed as `£3,500` via `"£"#,##0`. Reading the value alone turns
pounds into dollars. Both this app and the Python ETL read the format and use it as the
currency when the text itself does not say. 31 rows in the source workbook were wrong
before this was fixed.

`commercials` always stores the original text; the derived currency is recorded in
`raw_data.fee_currency_from_cell_format`.

## Structure

```
electron/main.cjs           window, external-link handling
src/lib/supabaseClient.ts   the two shared clients + error messages
src/lib/parsing.ts          cleaning rules, ported from the Python ETL
src/services/
  creatorsService.ts        every read query + filter composition
  uploadService.ts          file parsing, column mapping, upsert
src/hooks/
  useCreators.ts            paged results, debounced, stale-response safe
  useFilterOptions.ts       distinct values for the controls
src/components/             FilterPanel, ResultsTable, Pagination, UploadModal, ui
```

No Supabase call is made from a component — they all go through `services/`, reached
via the hooks.

## Adding a creator by hand

**Add creator** in the header, for creators that are not in any sheet. Input is messy
on purpose: `88.4k` becomes 88,400, `INR 25k` becomes 25,000 INR converted to USD, and
tracking parameters are stripped from the URL. The same cleaning code runs on it as on
a sheet row, so a value typed here lands identically to the same value in a cell.

The write goes through the `sync-sheet` Edge Function rather than straight to Postgres,
so the service role key never ships in the browser bundle — it uses `VITE_SYNC_SECRET`,
which only permits this one operation.

Rows added this way carry `manually_added = true` and are excluded from sync pruning.
Without that they would be deleted within a minute of being added: the prune removes
anything in a synced brand that the latest sheet run did not stamp, and a hand-added
row never is. Because of the flag it is safe to file a manual creator under a brand
whose sheet syncs every minute.

## Fees are in USD

Every fee in the table is USD. `commercials_amount` holds the converted value and the
Fee (USD) column sorts and filters on it, so "under $500" means real dollars. The
**Quoted as** column shows the original figure (`£500`, `₹120,000`) for anything not
quoted in dollars, and the fee filter's hint line shows the rate date.

Conversion rates come from the `fx_rates` table, which the upload path reads too — so
a newly uploaded sheet is converted with exactly the rates the stored rows used. To
refresh rates, see `refresh_fx.py` in the repository root.

## Filters

Every filter combines with AND. Dropdown values come from the database at runtime via
the `creators_filter_options()` RPC, never a hardcoded list, so they grow with the data.

Each multi-select has a **Select all** control. It acts on what is currently *visible*,
so typing "ai" into the category search and hitting Select all selects that subset
rather than silently selecting all 409 categories. The checkbox shows an indeterminate
state when only some visible options are selected, and flips to "Deselect all" once
they all are.

**Search** matches creator name, channel link, email, deliverables and the raw fee text.
`creator_name` is a generated column derived from the profile handle
(`instagram.com/iharnoor` -> `iharnoor`), since the source sheets carry no name column.
It is the first column in the results table and is sortable.

**Quoted currency** filters on `commercials_currency_native` — the currency a fee was
originally quoted in — because every stored `commercials_currency` is now `USD`.

Category needs care: the sheets spell things inconsistently (`ai`, `Ai`, `AI`, `Tech `).
The table has a generated `category_norm` column holding the lowercased, trimmed array,
and the filter matches against that — so selecting **AI** finds all three spellings. The
dropdown shows the most common spelling with a row count, ordered by frequency. The
`category` column itself keeps whatever the sheet said.

`Any of` matches rows having at least one selected category (`overlaps`); `All of`
requires every one (`contains`).

## Dark mode

Three-way toggle in the header: **Light / Dark / System**. System follows the OS and
keeps following it if the OS setting changes while the app is open. The choice is
remembered per browser in `localStorage`, wrapped in try/catch so a private window or
blocked site data falls back to System rather than throwing.

Tailwind runs in `darkMode: 'class'`, and an inline script in `index.html` sets the
class before React boots — otherwise a dark-mode user gets a white flash on every load.

Two things worth knowing if you add UI:

- Pair every colour utility with a `dark:` variant. Contrast was measured, not eyeballed:
  everything except the idle sort indicator clears WCAG AA in dark mode, and that one is
  deliberately dim (it is the `slate-300` idle affordance, and brightens when active).
- Text inputs and selects carry no background class, so in dark mode they would fall
  back to the browser's grey default. `index.css` styles them explicitly.

## Known behaviour

- Results are capped at 5,000 rows for CSV export, paged 1,000 at a time.
- Search covers channel link, email, deliverables and the raw fee text.
- `subscribers` is populated for YouTube, `followers` for Instagram/TikTok. The
  Audience column shows whichever applies and labels it.
