-- TEST ONLY: minimal Supabase Auth contract, not a replacement for hosted Auth.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Model older Supabase projects' permissive defaults; the migration must revoke them.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  encrypted_password text
);
create function auth.uid() returns uuid language sql stable set search_path = ''
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
insert into auth.users(id, email, raw_user_meta_data, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000001', 'reader@example.test', '{"display_name":"Reader","role":"admin","is_admin":true}', now()),
  ('00000000-0000-0000-0000-000000000002', 'admin@example.test', '{"display_name":"Editor"}', now()),
  ('00000000-0000-0000-0000-000000000003', 'other@example.test', '{"display_name":"Other"}', now()),
  ('00000000-0000-0000-0000-000000000004', 'pending@example.test', '{"display_name":"Pending"}', null),
  ('00000000-0000-0000-0000-000000000005', 'o''reilly@example.test', '{}', now());
