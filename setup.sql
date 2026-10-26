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
