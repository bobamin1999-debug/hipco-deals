-- HIPCO Deals: database setup. Paste all of this into Supabase -> SQL Editor -> New query -> Run.
-- Safe to run more than once.

-- 1. Team list: who may open the app, and who may change things -----------------------------
create table if not exists public.members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;
drop policy if exists "read own membership" on public.members;
create policy "read own membership" on public.members for select to authenticated using (user_id = auth.uid());

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;
create or replace function public.is_editor() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'editor');
$$;

-- 2. Shared data: every deal, client file list and setting lives in one table ---------------
create table if not exists public.kv (
  col        text not null,                      -- collection: deals, clients, config
  id         text not null,                      -- record id, e.g. HIP-26073, F2621, INQ-012
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (col, id)
);
alter table public.kv enable row level security;
alter table public.kv replica identity full;      -- live updates carry the whole row

drop policy if exists "team reads"      on public.kv;
drop policy if exists "editors add"     on public.kv;
drop policy if exists "editors change"  on public.kv;
drop policy if exists "editors delete"  on public.kv;
create policy "team reads"     on public.kv for select to authenticated using (public.is_member());
create policy "editors add"    on public.kv for insert to authenticated with check (public.is_editor());
create policy "editors change" on public.kv for update to authenticated using (public.is_editor()) with check (public.is_editor());
create policy "editors delete" on public.kv for delete to authenticated using (public.is_editor());

create or replace function public.kv_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end $$;
drop trigger if exists kv_touch on public.kv;
create trigger kv_touch before insert or update on public.kv for each row execute function public.kv_touch();

-- merge a few fields into a record (used by every button in the app)
create or replace function public.kv_merge(p_col text, p_id text, p_patch jsonb) returns boolean
  language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if not public.is_editor() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.kv set data = data || p_patch where col = p_col and id = p_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function public.kv_merge(text, text, jsonb) from anon;

-- table access for signed-in users (the row-level security rules above still decide what each person sees)
grant select on public.members to authenticated;
grant select, insert, update, delete on public.kv to authenticated;
revoke all on public.kv, public.members from anon;
grant execute on function public.kv_merge(text, text, jsonb) to authenticated;

-- live updates to every phone
do $$ begin
  alter publication supabase_realtime add table public.kv;
exception when duplicate_object then null; end $$;

-- 3. Attachments: private bucket, 20 MB per file, PDFs/photos/text only ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('deal-files', 'deal-files', false, 20971520,
        array['application/pdf','image/png','image/jpeg','image/gif','image/webp','video/mp4','video/webm',
              'text/csv','text/plain','text/markdown','application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "team reads deal files"     on storage.objects;
drop policy if exists "editors upload deal files" on storage.objects;
drop policy if exists "editors delete deal files" on storage.objects;
create policy "team reads deal files"     on storage.objects for select to authenticated using (bucket_id = 'deal-files' and public.is_member());
create policy "editors upload deal files" on storage.objects for insert to authenticated with check (bucket_id = 'deal-files' and public.is_editor());
create policy "editors delete deal files" on storage.objects for delete to authenticated using (bucket_id = 'deal-files' and public.is_editor());

-- 4. Add people (run after creating each login in Authentication -> Users -> Add user) --------
-- Replace the emails, keep the quotes. 'editor' can change things, 'viewer' can only look.
-- insert into public.members (user_id, email, role)
--   select id, email, 'editor' from auth.users where email = 'bob@example.com'
--   on conflict (user_id) do update set role = excluded.role;
-- insert into public.members (user_id, email, role)
--   select id, email, 'viewer' from auth.users where email = 'ahmad@example.com'
--   on conflict (user_id) do update set role = excluded.role;

-- 5. Push notifications --------------------------------------------------------------------
-- Each phone that switches alerts on is saved here. Every change to a deal, and a daily check at 08:00 Beirut,
-- calls the Edge Function `notify`, which sends the notification to everyone except the person who made the change.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  sub        jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own alerts" on public.push_subs;
create policy "own alerts" on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());
grant select, insert, update, delete on public.push_subs to authenticated;
revoke all on public.push_subs from anon;

create table if not exists public.push_log (deal_id text primary key, label text, sent_on date);   -- last alert told per deal
alter table public.push_log enable row level security;                                              -- no policies: app can't read it
revoke all on public.push_log from anon, authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.cfg (k text primary key, v text not null);
-- insert into private.cfg values ('notify_url', 'https://<project-ref>.supabase.co/functions/v1/notify'), ('notify_secret', '<same as NOTIFY_SECRET>'), ('notify_auth', '<legacy anon key>')
--   on conflict (k) do update set v = excluded.v;

create or replace function private.notify(body jsonb) returns void
  language plpgsql security definer set search_path = public, private as $$
declare u text; s text; a text;
begin
  select v into u from private.cfg where k = 'notify_url';
  select v into s from private.cfg where k = 'notify_secret';
  select v into a from private.cfg where k = 'notify_auth';     -- the project's legacy anon key (public), so the function's JWT check passes
  if u is null or s is null then return; end if;
  perform net.http_post(url := u, body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hipco-secret', s, 'Authorization', 'Bearer ' || coalesce(a, '')),
    timeout_milliseconds := 10000);
end $$;

create or replace function private.kv_notify() returns trigger
  language plpgsql security definer set search_path = public, private as $$
begin
  if coalesce(new.col, old.col) not in ('deals', 'clients') then return null; end if;
  if tg_op = 'UPDATE' and old.data = new.data then return null; end if;
  perform private.notify(jsonb_build_object('type', 'change', 'op', tg_op, 'col', coalesce(new.col, old.col), 'id', coalesce(new.id, old.id),
    'old', case when tg_op = 'INSERT' then null else old.data end, 'new', case when tg_op = 'DELETE' then null else new.data end,
    'by', coalesce(auth.uid(), case when tg_op = 'DELETE' then null else new.updated_by end)));
  return null;
end $$;
drop trigger if exists kv_notify on public.kv;
create trigger kv_notify after insert or update or delete on public.kv for each row execute function private.kv_notify();

select cron.unschedule('hipco-daily-alerts') where exists (select 1 from cron.job where jobname = 'hipco-daily-alerts');
select cron.schedule('hipco-daily-alerts', '0 6 * * *', $$ select private.notify('{"type":"scan"}'::jsonb) $$);   -- 06:00 UTC = 08:00 Beirut (winter)
