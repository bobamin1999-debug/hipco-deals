# Instructions for Claude working on HIPCO Deals

You are helping HIPCO's team (Bob = Ibrahim Amin, Lama) build and run **HIPCO Deals**, a phone app (PWA) that the CEO, Ahmad, uses every day.
Live app: https://bobamin1999-debug.github.io/hipco-deals/ · Code: this repository (public) · Data: Supabase project `lkgvghqvtkbqrovfohqe`.
Read `README.md` for the parts of the system. These rules come first.

## Before you change anything
1. `git pull` first. Two people (Bob and Lama) work on this app, each with their own Claude. Only one person changes the app at a time.
2. Say in one line what you are about to change. For anything that deletes data or changes many deals, show the plan and wait for "approve".
3. Ahmad uses the app live. Never leave it broken: test before you push.

## Security (never break these)
- **No company data in this repository.** No customer names, prices, quantities, offers, supplier contacts or statements in any committed file. The repository is public. Data lives only in Supabase (table `kv`), behind logins and row-level security.
- Never use, ask for, or paste the Supabase **service_role / secret key**, the VAPID private key or `NOTIFY_SECRET`. They live only in Supabase → Edge Functions → Secrets, entered by a person.
- Never learn or type anyone's password. People create their own logins; you only add them to `public.members` (role `editor` or `viewer`).
- Do not touch other Supabase projects or organizations. Work only in project `lkgvghqvtkbqrovfohqe`.
- Do not switch off security settings (RLS, "Verify JWT", sign-up stays disabled). If a step needs one, explain it and let a person do it.

## How the app is built
- `index.html` holds the whole app (HTML, CSS, JS). `db.js` talks to Supabase. `sw.js` is the offline cache. `config.js` holds only public keys.
- Data: table `public.kv (col, id, data jsonb)`. Collections: `deals`, `clients`, `config` (settings), `prices` (`current`, `older`, `suppliers`).
- Deal stages: `offer` → `signed` → `order` → `closed`. `kind` is `offshore` or `local` (Beirut). The app opens on a "Which business?" choice (back since 13.11.2026); keep the two separate, never mix their numbers. Beirut shares the offshore price list.
- Tabs: Today · This week · Offers · Clients · Shipments · Prices. Alerts come from `assess(d)` (level 1 urgent, 2 this week, 3 follow-up).
- Notifications: database trigger `kv_notify` → Edge Function `notify` (`supabase/functions/notify/index.ts`) → Web Push to every subscribed phone, except the person who made the change. A daily job (`hipco-daily-alerts`, 06:00 UTC) sends reminders. `assess()` in `notify/index.ts` must stay identical to the one in `index.html`.
- Bulk data loads: run `alter table public.kv disable trigger kv_notify;` before and `enable` after, so the team doesn't get dozens of notifications.

## Business rules (agreed with Bob)
- **Never guess data.** If it isn't in the source, write "not stated" and ask.
- **Mill PI counts as signed only** when a signed PI from the mill is attached (file category `pi`), or the shipment has a B/L / is shipped / arrived. Placing a mill order does not mean the PI is signed.
- Margins and profit show for offers too, even before the client signs. Profit = margin per MT × quantity.
- The pending-offers sheet is its own category (`sheet: "pending-offers"`), never merged into the client statement deals.
- Money: `paid`, `balance`, `dues` by month (`{"YYYY-MM": amount}`). Statement totals must still match the source after any change.
- Writing style in the app: plain English, short labels, dates as DD.MM.YYYY. In HIPCO documents: write FBB as "FBB/GC1", refs use NH (e.g. HIP 197/2026/AH/NH).

## Publishing a change
1. Edit the files. Bump `VERSION` in `sw.js` (e.g. `hipco-deals-v18` → `v19`) so phones load the new version.
2. Test locally with a browser at phone width (390 px) and desktop; check the browser console has no errors.
3. If you changed `notify/index.ts`, deploy it in Supabase → Edge Functions → notify → Code → Deploy.
4. Commit with a clear message and push to `main`. GitHub Pages publishes in 1–2 minutes.
5. Tell the team in one or two sentences what changed. Keep the previous commit so "undo" is a `git revert`.
