# Google Sheet → Supabase sync

Your client edits the Google Sheet; Supabase follows. Nothing runs on your laptop.

## How it works

An Edge Function (`sync-sheet`) fetches the sheet, cleans it with the same rules as
`etl.py`, and upserts into `creators`. Three things can trigger it:

| Trigger | Latency | Needs setup |
|---|---|---|
| **Apps Script in the sheet** — fires on every edit | ~15 seconds | Yes, one-time (below) |
| **pg_cron** — every 15 minutes | ≤ 15 minutes | Already running |
| **"Sync now"** button in the desktop app | immediate | Already working |

The cron job is the safety net. Even if the Apps Script is removed, unauthorised, or
Google has an outage, the database is never more than 15 minutes stale.

**Deletions mirror the sheet.** Remove a creator from a synced tab and it is removed
from Supabase on the next sync. Rows added through the app's Upload feature under a
different `source_sheet` are never touched.

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

The sync knows the six tabs and their column layouts. If your client **adds a new tab**,
it is ignored until it is added to `TAB_LAYOUT` in
`supabase/functions/sync-sheet/sheet.ts`, then redeployed:

```bash
supabase functions deploy sync-sheet --project-ref akqhuzgekjsvrizysfmp --no-verify-jwt
```

Reordering or inserting **rows** is fine — the reader works out each row's layout from
its contents rather than assuming fixed row numbers. Adding or moving a **column**
within an existing tab needs the layout updated.

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
