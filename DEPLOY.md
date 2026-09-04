# Deploying the web build

## The error you're seeing

"Supabase is not configured — VITE_SUPABASE_URL is not set" means the build had no
environment variables. `.env` is git-ignored (correctly — it holds secrets), so Vercel
never received them. The app built and loaded fine; it just has nothing to connect to.

## The fix — 2 minutes

In the Vercel project: **Settings → Environment Variables**, add these two for
Production, Preview and Development, then **Redeploy**:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://akqhuzgekjsvrizysfmp.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_ZqxJZMUFFB1LQmcpV92b5w_66qDwpiZ` |

Vercel does not rebuild on an env var change by itself — you must redeploy, or the
bundle still won't have them.

If the build itself fails, set **Root Directory** to `app` in Settings → General; the
React app lives in that subfolder, not the repo root.

## Editing and adding on the web needs one more variable

`VITE_SYNC_SECRET` is what lets the browser call the `sync-sheet` Edge Function, and
that function is the only path the app has for **Add creator**, **Edit creator**,
**Connect a sheet** and **Sync now**. Without it those are visibly disabled — an amber
"needs VITE_SYNC_SECRET" note, greyed-out Save — while filtering, search and export
carry on working. Nothing crashes; the app just runs read-only.

Whether to set it depends entirely on whether the URL is protected, because every
`VITE_` variable is compiled into the JavaScript bundle and readable in DevTools:

| Deployment Protection | Set `VITE_SYNC_SECRET`? |
|---|---|
| **On** (Vercel Authentication or a password) | Yes. Only people who get past the login can read the bundle, and they are people you already trust with the data. |
| **Off** — anyone with the link | No. It would let any visitor trigger unlimited syncs and write to your table. |

Check which you have under **Settings → Deployment Protection**. As of the last
check the production URL redirects to Vercel SSO, so protection is **on** and setting
the variable is reasonable.

`VITE_SUPABASE_SERVICE_ROLE_KEY` is a different matter: never set it on any web
deployment, protected or not. It bypasses RLS completely and would hand the whole
database to anyone who opens DevTools past the login. Uploads that need it stay in
the Electron build.

## Before you share the URL — read this

The publishable key ships inside the bundle by design, and RLS currently lets it read
the whole table:

```
GET /rest/v1/creators  ->  200, content-range: 0-999/1254
```

Anyone who opens the site — or just extracts the key from the JS and queries Supabase
directly — can read **all 1,254 creators: names, email addresses, negotiated rates,
deliverables**. There is no login on this app. It was built as an internal Electron
tool, where "anyone with the app" meant your team.

A public Vercel URL changes who that is. Three ways to handle it:

**1. Keep it private (simplest).** Vercel's Password Protection or Vercel
Authentication under Settings → Deployment Protection. Note that on the Hobby plan,
password protection is a paid feature — Vercel Authentication (SSO for your own team)
is available and enough if only you use it.

**2. Add a login.** Supabase Auth, then narrow the RLS policy from `using (true)` to
`using (auth.role() = 'authenticated')`. Proper access control; costs an auth screen
and user management. Say the word and I'll build it.

**3. Don't deploy publicly.** Use the Electron build and keep the database closed.

Since the last check, option 1 is in place: the production URL redirects to Vercel
SSO, so the table is no longer readable by anyone with the link. Option 2 is still
worth doing if you ever need more than one person on it without giving them access
to your Vercel account — say the word and I'll build it.

## Local development

```bash
cd app
cp .env.example .env      # fill in the two values above
npm run dev:web           # browser at http://localhost:5173
npm run dev               # Electron window
```
