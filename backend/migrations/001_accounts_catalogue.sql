-- Run as the database owner in a Supabase project. Safe to reapply.
-- Keep private OUT of the project's exposed API schemas.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create table if not exists private.admin_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Only the database owner can change membership. Auth metadata is never consulted.
alter table private.admin_members enable row level security;
revoke all on private.admin_members from public, anon, authenticated, service_role;
revoke all (user_id, created_at) on private.admin_members from public, anon, authenticated, service_role;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.admin_members m
    join auth.users u on u.id = m.user_id
    where m.user_id = (select auth.uid()) and u.email_confirmed_at is not null
  );
$$;
revoke all on function private.is_admin() from public, anon, authenticated, service_role;
grant execute on function private.is_admin() to authenticated;

-- API wrapper: privileged implementation stays in the unexposed schema.
create or replace function public.is_admin()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.is_admin(); $$;
revoke all on function public.is_admin() from public, anon, authenticated, service_role;
grant execute on function public.is_admin() to authenticated;

create or replace function private.create_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, display_name, created_at)
  values (
    new.id,
    case when jsonb_typeof(new.raw_user_meta_data -> 'display_name') = 'string'
      then left(btrim(new.raw_user_meta_data ->> 'display_name'), 80) else '' end,
    coalesce(new.created_at, now())
  ) on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.create_profile() from public, anon, authenticated, service_role;
drop trigger if exists anchor_create_profile on auth.users;
create trigger anchor_create_profile after insert on auth.users
  for each row execute function private.create_profile();
insert into public.profiles(id, display_name, created_at)
select u.id,
  case when jsonb_typeof(u.raw_user_meta_data -> 'display_name') = 'string'
    then left(btrim(u.raw_user_meta_data ->> 'display_name'), 80) else '' end,
  coalesce(u.created_at, now())
from auth.users u on conflict (id) do nothing;

alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated, service_role;
revoke all (id, display_name, created_at) on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant all on public.profiles to service_role;
drop policy if exists anchor_profiles_read_own on public.profiles;
create policy anchor_profiles_read_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
drop policy if exists anchor_profiles_update_own on public.profiles;
create policy anchor_profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Bound both structure and content before saving a catalogue entry.
-- total_words is bounded client metadata, not a second implementation of the RSVP tokenizer.
create or replace function private.valid_book_chapters(value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = ''
as $$
declare
  chapter jsonb;
  paragraph jsonb;
  paragraph_count integer := 0;
begin
  if value is null or jsonb_typeof(value) <> 'array' then return false; end if;
  if jsonb_array_length(value) not between 1 and 2000
    or octet_length(value::text) > 20971520 then return false; end if;
  for chapter in select jsonb_array_elements(value) loop
    if jsonb_typeof(chapter) <> 'object' then return false; end if;
    if jsonb_typeof(chapter -> 'title') is distinct from 'string'
      or char_length(chapter ->> 'title') not between 1 and 300
      or (chapter ->> 'title') !~ '[^[:space:]]'
      or jsonb_typeof(chapter -> 'paragraphs') is distinct from 'array'
      or chapter - 'title' - 'paragraphs' <> '{}'::jsonb then return false; end if;
    if jsonb_array_length(chapter -> 'paragraphs') not between 1 and 20000 then return false; end if;
    paragraph_count := paragraph_count + jsonb_array_length(chapter -> 'paragraphs');
    if paragraph_count > 100000 then return false; end if;
    for paragraph in select jsonb_array_elements(chapter -> 'paragraphs') loop
      if jsonb_typeof(paragraph) <> 'string'
        or char_length(paragraph #>> '{}') not between 1 and 200000
        or (paragraph #>> '{}') !~ '[^[:space:]]' then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;
revoke all on function private.valid_book_chapters(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.valid_book_chapters(jsonb) to authenticated, service_role;
grant usage on schema private to service_role;

create table if not exists public.catalogue_books (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  title text not null check (char_length(title) between 1 and 240 and title ~ '[^[:space:]]'),
  author text not null default '' check (char_length(author) <= 160),
  year integer check (year between -3000 and 3000),
  source_url text check (char_length(source_url) <= 2048 and source_url ~ '^https://[^[:space:]/?#]+([/?#][^[:space:]]*)?$'),
  chapters jsonb not null check (private.valid_book_chapters(chapters)),
  total_words integer not null check (total_words between 1 and 2000000),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists anchor_catalogue_published on public.catalogue_books(published, created_at desc);

create or replace function private.touch_catalogue_book()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function private.touch_catalogue_book() from public, anon, authenticated, service_role;
drop trigger if exists anchor_touch_catalogue_book on public.catalogue_books;
create trigger anchor_touch_catalogue_book before update on public.catalogue_books
  for each row execute function private.touch_catalogue_book();

alter table public.catalogue_books enable row level security;
revoke all on public.catalogue_books from public, anon, authenticated, service_role;
revoke all (id, title, author, year, source_url, chapters, total_words, published, created_at, updated_at)
  on public.catalogue_books from public, anon, authenticated;
grant select on public.catalogue_books to anon, authenticated;
grant insert (id, title, author, year, source_url, chapters, total_words, published),
  update (id, title, author, year, source_url, chapters, total_words, published)
  on public.catalogue_books to authenticated;
grant delete on public.catalogue_books to authenticated;
grant all on public.catalogue_books to service_role;
drop policy if exists anchor_catalogue_public_read on public.catalogue_books;
create policy anchor_catalogue_public_read on public.catalogue_books for select to anon, authenticated
  using (published);
drop policy if exists anchor_catalogue_admin_read on public.catalogue_books;
create policy anchor_catalogue_admin_read on public.catalogue_books for select to authenticated
  using ((select private.is_admin()));
drop policy if exists anchor_catalogue_admin_insert on public.catalogue_books;
create policy anchor_catalogue_admin_insert on public.catalogue_books for insert to authenticated
  with check ((select private.is_admin()));
drop policy if exists anchor_catalogue_admin_update on public.catalogue_books;
create policy anchor_catalogue_admin_update on public.catalogue_books for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists anchor_catalogue_admin_delete on public.catalogue_books;
create policy anchor_catalogue_admin_delete on public.catalogue_books for delete to authenticated
  using ((select private.is_admin()));

create or replace function private.admin_list_users()
returns table (id uuid, email text, display_name text, created_at timestamptz,
  last_sign_in_at timestamptz, email_confirmed_at timestamptz, is_admin boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query select u.id, u.email::text, coalesce(p.display_name, ''), u.created_at,
    u.last_sign_in_at, u.email_confirmed_at,
    (m.user_id is not null and u.email_confirmed_at is not null)
  from auth.users u left join public.profiles p on p.id = u.id
    left join private.admin_members m on m.user_id = u.id
  order by u.created_at desc, u.id;
end;
$$;
revoke all on function private.admin_list_users() from public, anon, authenticated, service_role;
grant execute on function private.admin_list_users() to authenticated;
create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, created_at timestamptz,
  last_sign_in_at timestamptz, email_confirmed_at timestamptz, is_admin boolean)
language sql stable security invoker set search_path = ''
as $$ select * from private.admin_list_users(); $$;
revoke all on function public.admin_list_users() from public, anon, authenticated, service_role;
grant execute on function public.admin_list_users() to authenticated;

notify pgrst, 'reload schema';
commit;
