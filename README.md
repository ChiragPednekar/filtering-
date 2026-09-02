# Creators ETL — Google Sheets → Supabase

Builds one `creators` table in Supabase from the influencer workbook, normalising six
tabs with inconsistent schemas onto a single canonical shape.

Current run: **1,363 sheet rows → 1,258 records**, 100% of present fees parsed.

---

## Setup (once)

```bash
python3 -m venv .venv && ./.venv/bin/pip install openpyxl
```

Create a `.env` (already git-ignored — the service role key bypasses RLS, so it must
never reach a browser, a client bundle, or a commit):

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

Apply the schema once, from the Supabase SQL editor or the CLI:

```bash
psql "$DATABASE_URL" -f migrations/0001_create_creators.sql
```

---

## Re-running

```bash
set -a && . ./.env && set +a && ./.venv/bin/python etl.py --upsert
```

That re-fetches the sheet, re-cleans everything, and upserts. Existing creators are
updated in place rather than duplicated — the conflict target is
`(channel_link, source_sheet, variant_no)`.

Other modes:

| Command | What it does |
|---|---|
| `python etl.py` | Dry run. Cleans and writes `out/creators.json`, touches no database. |
| `python etl.py --local data/workbook.xlsx` | Uses an already-downloaded file instead of fetching. |
| `python etl.py --upsert` | Fetch, clean, and push to Supabase. |
| `python etl.py --refresh-fx` | Re-fetch exchange rates before converting. |

**Always dry-run first** after any sheet change and read the summary it prints. If
`fees present but unparsed` or `no usable URL` moves, the sheet has grown a format the
parsers don't know yet.

---

## Adding a new sheet or tab

1. **Print the real headers first.** Never assume row 1 describes the whole tab —
   three tabs in this workbook restate their header mid-sheet, and Sheet2 changes
   column layout halfway down.

   ```bash
   ./.venv/bin/python -c "
   import openpyxl
   wb=openpyxl.load_workbook('data/workbook.xlsx',read_only=True)
   for ws in wb.worksheets:
       print(ws.title, [c.value for c in next(ws.iter_rows(max_row=1))])"
   ```

2. **Point the tab at a layout** in `etl.py`. `LAYOUTS` maps *column position* to
   canonical field; `TAB_LAYOUTS` says which layout each tab uses. Positions are the
   authority because tabs rename columns (`Email ID` for `Mail`, `Followers` for
   `Subscribers`) without reordering them. If the new tab matches an existing shape,
   one line in `TAB_LAYOUTS` is the whole change:

   ```python
   TAB_LAYOUTS = { ..., "Sheet10": "default_9col" }
   ```

   If its column order is new, add an entry to `LAYOUTS` describing it.

3. **For a different workbook**, set `SHEET_ID` in the environment. It must be shared
   as "anyone with the link can view" — the script fetches the public xlsx export and
   uses no Google credentials.

4. Dry-run, read the summary, then `--upsert`.

---

## What the cleaning does

- **Fees** — parses amount and currency out of `$100`, `INR 24,000`, `€450`,
  `1500 Euros`, `INR 65K`, `$2,100`, `4000EUR`, `INR 4L+GST` (Indian lakh → 400000),
  `1Lakhs INR`, `£3.5k+ VAT`, `$3000 AUD` (explicit code beats the `$` symbol).
  Where the text carries no currency, the **cell's number format** is used: a cell
  holding `3500` formatted as `"£"#,##0` means GBP, not USD. 31 rows depended on this.
  Where a cell lists several prices — `$300/ $600`, `$399/ $649/ $1,149` — the
  **lowest** goes in `commercials_amount` and every value is kept in
  `raw_data->'fee_parsed'`. `GST`/`VAT`/`PayPal`/agency exclusions are noted in
  `raw_data->'fee_excludes'`. Bare numbers default to USD (several tabs head the
  column "Commercials ( $ )") and are flagged `fee_currency_inferred`.
- **Categories** — split on `,` `/` `|` `&` into a deduplicated `text[]`.
- **Emails** — validated. Non-email values (`DM`, `WAP`, a WhatsApp link) leave the
  email columns NULL and are kept in `raw_data->'email_raw_non_email'`; a bare phone
  number is classified the same way. Multi-address cells keep the first and list all
  in `raw_data->'email_all'`.
- **Audience** — `207K`, `1.2M`, `40.3L` → integers, routed by platform: YouTube fills
  `subscribers`, Instagram/TikTok fill `followers`.
- **Platform** — inferred from the URL, which is more reliable than the platform
  column (a block of Sheet2 rows carries a subscriber count there).
- **URLs** — normalised to `https://host/path`, lowercased host, no `www.`, no
  trailing `?` or `/`, so `.../iharnoor?` and `.../iharnoor` are one creator.
- Every row keeps its full original values plus source tab and row number in
  `raw_data`, so nothing the mapping missed is lost.

---

## Two things to know about the data

**`channel_link` alone is not unique.** 1,363 rows cover 1,059 distinct creators, and
100 of them carry *different* negotiated fees in different tabs — `@timexplainsai` is
$700 in Sheet2 and $800 in Sheet7. Some appear twice within one tab with different
deliverable packages. A unique constraint on `channel_link` alone would have silently
discarded ~300 rows and 100 real price conflicts, so the key is
`(channel_link, source_sheet, variant_no)`. Byte-identical repeats (104 of them) are
still collapsed; only genuine variants get their own `variant_no`.

To get one preferred row per creator:

```sql
select distinct on (channel_link) *
from public.creators
order by channel_link, commercials_amount asc nulls last, updated_at desc;
```

**One row has no URL.** `freeman ai - YouTube` in Sheet2 is a channel name, not a
link, so it cannot be keyed. It is written to `out/creators_no_url.json` rather than
dropped. Paste a real URL into the sheet and it loads on the next run.

---

## Security

`migrations/0001_create_creators.sql` enables RLS with **no policies** and revokes the
`anon` and `authenticated` grants. Those are the keys that ship to browsers, so they
can read and write nothing. `service_role` bypasses RLS, which is how the ETL writes.

Adding any policy to this table opens it up. Do that deliberately.

## Currency: everything is stored in USD

Fees are stored in `commercials_amount` as **USD**, so one filter means one thing.
Before this, "under 500" matched $500, EUR 500 (~$580) and INR 500 (~$5) alike.

What each column holds:

| Column | Meaning |
|---|---|
| `commercials` | the original fee text, verbatim (`£500`, `INR 4L+GST`, `$300/ $600`) |
| `commercials_amount` / `commercials_currency` | **USD**, always |
| `commercials_amount_native` / `commercials_currency_native` | what the creator actually quoted |
| `fx_rate` / `fx_rate_date` | the rate used, and when it was taken |

The quoted figure is never overwritten — when you negotiate with a UK creator you need
to know they asked for £500, not $676.

Rates live in the `fx_rates` table. To refresh them:

```bash
set -a && . ./.env && set +a && ./.venv/bin/python refresh_fx.py --apply
```

Run it without `--apply` first: it prints the old rate, the new rate and the percentage
change for every currency in use, and writes nothing.

## Live sync from the Google Sheet

The sheet is the source of truth: your client edits it and Supabase follows, with no
laptop involved. Edits land in ~15 seconds via an Apps Script trigger, a pg_cron job
re-syncs every 15 minutes as a safety net, and the app has a **Sync now** button.
Deletions mirror the sheet. See **[SYNC.md](SYNC.md)** — it has the one-time Apps
Script setup and the monitoring queries.

`etl.py` is still the tool for a bulk reload or a one-off import; the sync is the
day-to-day path.

## Desktop app

`app/` holds an Electron + React front end for filtering this table and uploading new
sheets. See [app/README.md](app/README.md). It reads with the publishable key (RLS
allows it `SELECT` only) and needs the service role key only for uploads.

Its TypeScript cleaning rules in `app/src/lib/parsing.ts` mirror the parsers in
`etl.py` — change one and change the other. `cd app && npm run test:upload` checks
them against the real workbook.

## Layout

```
etl.py                              extract / transform / load (bulk / one-off)
refresh_fx.py                       refresh exchange rates and re-convert fees
SYNC.md                             live Google Sheet -> Supabase sync
supabase/functions/sync-sheet/      the Edge Function that does the syncing
supabase/functions/_tests/          proves the sync matches etl.py exactly
google-apps-script/                 the trigger you paste into the sheet
migrations/
  0001_create_creators.sql          schema, indexes, RLS
  (0002, 0003 applied via Supabase) anon read policy, filter-options RPC,
                                    category_norm for case-insensitive filtering
HEADERS.md                          headers found in each tab + structural problems
out/creators.json                   cleaned records (dry-run output)
out/creators_no_url.json            rows held back for having no usable URL
data/workbook.xlsx                  cached download
app/                                Electron + React desktop app
```
