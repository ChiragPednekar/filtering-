# Email to the sheet owner

The Google Sheet is owned by **Sujal Chudmunge (sujalchudmunge0@gmail.com)**, so the
Apps Script bound to it belongs to that account. Only they can authorise it.

The script is already written and saved in the sheet. Send this, then they run it.

---

**To:** sujalchudmunge0@gmail.com
**Subject:** Action needed (2 min): authorise the auto-sync script on the Creators sheet

---

Hi Sujal,

I've set up automatic syncing between the "Copy of Copy of Creators (1700+)" sheet and
our database. Once it's switched on, any edit you make in the sheet shows up in our
system within about 15 seconds — no exports, no manual steps.

The script is already written and saved inside the sheet. There's just one thing I
can't do from my side: because the sheet is owned by your Google account, the script
belongs to your account too, so the one-time authorisation has to come from you.

It takes about two minutes:

1. Open the sheet, then go to **Extensions → Apps Script**
2. At the top there's a dropdown showing a function name. Change it to: **installTrigger**
3. Click **Run**
4. Google will show a warning: "Google hasn't verified this app". This is expected —
   the script lives in your own account and hasn't been through Google's public review
   process, which is normal for an internal script like this. Click **Advanced**, then
   **Go to Untitled project (unsafe)**, then **Allow**.
5. To confirm it worked: change the dropdown to **syncNow**, click **Run**, then open
   **View → Logs**. You should see a line ending in `HTTP 200`.

That's it — you can close the editor afterwards.

The project is currently called "Untitled project", so that's the name the permission
screen will show. Feel free to rename it to something like "Supabase Sync" from the
title at the top.

For transparency, here's exactly what the script does:

- Notices when the sheet has been edited
- Waits ~15 seconds so a burst of edits counts as one change
- Sends the sheet's contents to our database endpoint
- Nothing else. It doesn't read your other files, doesn't send email, and doesn't
  modify or share the sheet.

If anything looks off or you'd rather not approve it, just tell me and I'll take the
script back out — we have a backup sync that runs every 15 minutes regardless, so
nothing breaks either way.

Thanks,
Chirag

---

## Notes for you, not for the email

- **The sync secret is already in that script's properties**, and Sujal can read it
  (Project Settings → Script Properties). It only allows triggering a resync of this
  sheet — it cannot read or write your database directly, since RLS still applies. If
  you would rather they never see it, rotate it after setup:

  ```bash
  cd /Users/chiragyogeshpednekar/Documents/filtering
  NEW=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
  sed -i '' "s|^SYNC_SECRET=.*|SYNC_SECRET=$NEW|" .env
  sed -i '' "s|^VITE_SYNC_SECRET=.*|VITE_SYNC_SECRET=$NEW|" app/.env
  set -a && . ./.env && set +a
  supabase secrets set SYNC_SECRET="$SYNC_SECRET" --project-ref akqhuzgekjsvrizysfmp
  ```

  Rotating breaks the Apps Script trigger until the new value is put back into its
  Script Properties, so only do it if you intend to hand them a fresh one.

- **Nothing is running yet from the script.** No trigger is installed and no
  authorisation was granted. The 15-minute cron and the app's "Sync now" button are
  unaffected and still keep the database current.
