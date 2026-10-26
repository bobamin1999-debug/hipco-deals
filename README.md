# HIPCO Deals

HIPCO's deal tracker as a phone app (installs from the browser with "Add to Home Screen").
Every deal moves down one page: **Pending inquiries → Pending offers → Signed offers → Orders → Closed**.
Tap a deal to see its progress, documents and details. Built and operated by Claude for Bob (Ibrahim Amin).

## How it works

| Part | Where | Notes |
|---|---|---|
| App files | this repository, published free with GitHub Pages | `index.html`, `db.js`, `sw.js`, `manifest.json`, `icons/`, `vendor/` |
| Live data | Supabase table `kv` (col, id, data) | deals, clients (shared client documents), config (settings) |
| Attachments | Supabase Storage bucket `deal-files` (private) | opened through short-lived signed links |
| Logins | Supabase Authentication (email + password) | only people in the `members` table see anything |
| Offline | `sw.js` + phone storage | last data shown offline; changes made offline are sent when back online |

**No company data is ever committed to this repository.** The repository is public; the data lives only in Supabase,
behind logins and row-level security. `config.js` holds the project URL and the anon/publishable key, which are safe to
publish for that reason. The service_role / secret key is never put here or in chat.

## Who can do what

- `editor` (Bob): add and move deals, attach and remove files, change settings.
- `viewer` (Ahmad): sees everything live, opens and saves files, cannot change anything.

Add a person: Supabase → Authentication → Users → **Add user** → Create new user (email, password, tick *Auto Confirm User*),
then run the `insert into public.members ...` lines at the bottom of `setup.sql` with their email and role.
Keep *Authentication → Sign In / Providers → Allow new users to sign up* switched **off**.

## Updating

- App change: edit files, bump `VERSION` in `sw.js`, push to `main`. GitHub Pages deploys in 1–2 minutes; phones reload on the next open.
- New data from Excel/PDF: Claude reads it, shows a draft, and after "approve" writes it to Supabase (as a SQL file Bob runs, or through the app).
- Data import from the old Claude page: `python3 tools/export_to_sql.py <export_dir> seed.sql`, then run `seed.sql` in the SQL Editor.

## Standing rules

- Never guess data: anything not in the source is written as "not stated".
- Nothing goes live until Bob says "approve".
- Offer refs stay as HIPCO uses them (HIP 26xxx, offshore F26xx, inquiries INQ-0xx).

## Decisions

- 2026-10-26: Real logins (Supabase Auth) instead of a shared "secret header", because a header written in public code can be copied.
- 2026-10-26: Libraries (supabase-js 2.117.3, SheetJS 0.18.5) are bundled in `vendor/` so the app works offline and does not depend on a CDN.
- Push alerts (OneSignal) come in the next stage.

## Change log

- v1 (2026-10-26): first standalone version of the deals page: sign-in, live data, attachments, offline, install to home screen.
