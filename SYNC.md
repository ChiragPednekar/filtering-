# Google Sheet → Supabase sync

Your client edits the Google Sheet; Supabase follows. Nothing runs on your laptop.

**Source sheet:** `1jlfzZA0bIewRwYcWBApxPpbpWVJHJ97op3UmyGvV4jw`
(<https://docs.google.com/spreadsheets/d/1jlfzZA0bIewRwYcWBApxPpbpWVJHJ97op3UmyGvV4jw/edit>)

Only one sheet can drive the database, because deletions mirror it. Whichever sheet
this ID points at is the source of truth — edits to any other copy are invisible.
To repoint it, set the `SHEET_ID` secret on the Edge Function and redeploy:

```bash
supabase secrets set SHEET_ID=<new id> --project-ref akqhuzgekjsvrizysfmp
supabase functions deploy sync-sheet --project-ref akqhuzgekjsvrizysfmp --no-verify-jwt
```

Before switching sources, diff the two first — a copy is often a snapshot that has
drifted, and syncing it silently reverts whatever changed since. `etl.py --local`
against each file and comparing the output is enough to catch it.

## How it works

An Edge Function (`sync-sheet`) fetches the sheet, cleans it with the same rules as
`etl.py`, and upserts into `creators`. Three things can trigger it:

| Trigger | Latency | Needs setup |
|---|---|---|
| **Apps Script in the sheet** — fires on every edit | ~15 seconds | Yes, one-time (below) |
| **pg_cron** — every minute | ≤ 1 minute | Already running |
| **"Sync now"** button in the desktop app | immediate | Already working |

The cron job runs every minute, so the database is never more than about a minute
behind the sheet even with no Apps Script installed at all. It is also the safety net:
if the Apps Script is removed or unauthorised, nothing breaks.

A scheduled tick is skipped while a previous run is still in flight. Runs average ~4.5s
and the slowest on record is 17.65s, so overlap is unlikely -- but without the guard a
newer run's prune could delete rows an older, slower run had not yet re-stamped.

At this cadence the sync runs ~1,440 times a day. A nightly job keeps 7 days of
successful `sync_log` rows so the table cannot grow without bound; errors are kept.

**Deletions mirror the sheet.** Remove a creator from a synced tab and it is removed
from Supabase on the next sync. Rows added through the app's Upload feature under a
different `source_sheet` are never touched.

## You do not need to own the sheet

Editor access is enough. Google's docs are explicit that "installable triggers always
run under the account of the person who created them", and an installable onChange
trigger fires when *any* user edits the sheet. So an editor can install the trigger,
and it will catch the owner's edits, running under the editor's authorisation.

The one caveat: a container-bound script belongs to the *file owner*, so on a sheet you
do not own, the owner can change the script's code afterwards -- and it would then run
with your authorisation. On a sheet you own, that concern disappears.

## One-time setup for real-time (~3 minutes)

The other two triggers already work. This is only for near-instant updates.

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Delete whatever is in `Code.gs` and paste the contents of
   [`google-apps-script/SyncToSupabase.gs`](google-apps-script/SyncToSupabase.gs).
3. Find your secret — it is the `SYNC_SECRET` line in this repo's `.env`:

   ```bash
   grep SYNC_SECRET .env
   ```

4. In the Apps Script editor, paste that value into `setUpSecret()` where it says
   `PASTE_SECRET_HERE`, then pick **setUpSecret** in the function dropdown and press
   **Run**. Authorise it when Google asks. Then clear the secret back out of the code
   — it is stored in the script's properties now.
5. Pick **installTrigger** and press **Run**.
6. Pick **syncNow** and press **Run** to confirm. **View → Logs** should show
   `sync-sheet -> HTTP 200`.

Edits now reach Supabase in about 15 seconds.

### Why the 15-second delay

Edits arrive in bursts — a paste, a fill-down, someone tabbing across a row. Firing a
sync per keystroke would hammer the function and sync half-finished rows. The script
waits 15 seconds after the last edit, so a burst collapses into one run.

## Checking on it

```sql
select trigger, status, rows_upserted, rows_deleted, started_at,
       round(extract(epoch from (finished_at - started_at))::numeric, 2) as secs, error
from public.sync_log
order by id desc
limit 20;
```

`trigger` says which path fired it: `sheet-edit` (Apps Script), `cron`, `app-button`.
A typical run takes about 3 seconds.

To force a sync from SQL:

```sql
select public.trigger_sheet_sync('manual');
```

## Safety

- **A bad export cannot wipe the table.** If a sync would delete more than 20% of the
  rows in the synced tabs, it refuses and records an error instead. That covers a
  truncated export, a permissions change, or a half-written edit.
- **Zero rows is refused outright** — the function errors rather than treating an
  empty parse as "the client deleted everything".
- **Upsert runs before delete**, so a failure part-way through never leaves the table
  short.
- **Two secrets, two callers.** The Apps Script and the app hold `SYNC_SECRET`. The
  cron job sends a token the database generated for itself (`sync_auth`), so that
  secret never has to be written into a cron command, where anyone with database
  access could read it.
- The function endpoint is public but rejects anything without a valid secret (`401`).

## If the sheet's structure changes

**A new tab syncs on its own.** The six known tabs keep their pinned layouts; anything
new is read from its header row, so a tab your client adds starts syncing with no code
change. Header names do not have to match the existing ones — `Profile Link`, `Niche`,
`Region`, `Following`, `Price` and `Scope` all map correctly.

Each run reports what it found:

- `tabs_auto_detected` — new tabs it worked out for itself
- `tabs_unreadable` — tabs skipped because no column could be identified as the
  profile link (a Notes tab, say). Skipped rather than guessed at.

**Inserting or reordering rows is fine.** The reader works out each row's layout from
its contents rather than assuming fixed row numbers.

The only change still needing code is renaming a column to something the header
patterns do not recognise. Add the pattern to `HEADER_HINTS` in
`supabase/functions/sync-sheet/sheet.ts` and redeploy:

```bash
supabase functions deploy sync-sheet --project-ref akqhuzgekjsvrizysfmp --no-verify-jwt
```

## Repairs the sync makes automatically

The sheet is hand-maintained, so rows arrive with values in the wrong columns. Rather
than importing the mess, each run repairs what it can and counts what it did:

| Field in the sync result | What it fixes |
|---|---|
| `placeholder_values_cleared` | `Not Shared`, `N/A`, `-`, `Unknown` become NULL instead of being treated as a real country |
| `geo_fields_repaired` | Rows where Category / Language / Country are filled in the wrong order — a country filed as a category would otherwise pollute the filter dropdowns |
| `fee_cells_holding_deliverables` | A fee cell containing `1 Instagram Reel + link in bio` moves to the deliverables column instead of leaving the creator with no price |
| `skipped_rows` | Rows dropped for having no usable link, listed explicitly so a broken link is visible rather than silent |

Repairs are conservative: values are only moved when they identify themselves (a known
country name sitting in the category column, say), so a genuine category like `Tech` is
never touched. Every repair is recorded in that row's `raw_data`, so you can see what
was changed and why.

The original text is never overwritten — `commercials` still holds what the sheet said,
and `raw_data.original` holds the whole untouched row.

## Keeping the two pipelines in step

`etl.py` and the Edge Function must clean data identically, otherwise a sync would
rewrite rows the ETL produced. There is a test for exactly that:

```bash
cd supabase/functions/_tests && deno run --allow-read --allow-net --allow-import sync_sheet_test.ts
```

It runs the Edge Function's reader over the real workbook and diffs every field
against `etl.py`'s output. It should report `MATCH`. Run it after changing either
pipeline's parsing rules.

Two things that made them disagree, both fixed and worth knowing about if you touch
this code:

- **Number formatting.** openpyxl returns `350.0` where the cell holds `350`; JS gives
  `350`. Both now render whole numbers without the trailing `.0`.
- **Fingerprint hashing.** `variant_no` comes from a content hash. Hashing a JSON dump
  gave different digests in Python and TypeScript, so the two pipelines numbered
  variants differently and rewrote each other's rows. Both now build an explicit
  canonical string (`FINGERPRINT_FIELDS`, `\x1f`-joined) before hashing, and sort
  digests bytewise rather than with `localeCompare`.
