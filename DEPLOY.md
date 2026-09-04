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

## Do NOT set these two on a public deployment

| Name | Why not |
|---|---|
| `VITE_SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS completely. Every `VITE_` variable is compiled into the JavaScript bundle and readable by anyone who opens DevTools. On a public URL this hands the whole database — read, write, delete — to any visitor. |
| `VITE_SYNC_SECRET` | Lets anyone trigger unlimited sheet syncs against your project. |

Leaving them unset is not a degradation — the app detects it and runs read-only: the
header shows a `read-only` badge and the upload dialog explains why committing is
disabled. Filtering, CSV and PDF export all work.

Uploads and "Sync now" stay in the Electron build, which is distributed to people you
trust. That split is deliberate.

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

Until one of these is in place, treat the deployment URL as public — because it is.

## Local development

```bash
cd app
cp .env.example .env      # fill in the two values above
npm run dev:web           # browser at http://localhost:5173
npm run dev               # Electron window
```
