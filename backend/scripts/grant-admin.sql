-- psql --set=ON_ERROR_STOP=1 --set=admin_email='CONFIRMED_EMAIL' --file=backend/scripts/grant-admin.sql
-- Run only through the database owner's connection, never from the browser.
\set ON_ERROR_STOP on
\if :{?admin_email}
\else
  \echo 'Set admin_email to the confirmed account email.'
  \quit 1
\endif
begin;
create temporary table anchor_admin_target(email text) on commit drop;
insert into anchor_admin_target values (:'admin_email');
do $$
declare
  target_id uuid;
  matches integer;
  confirmed timestamptz;
begin
  if not pg_has_role(current_user,
    (select relowner from pg_class where oid = 'private.admin_members'::regclass), 'USAGE') then
    raise exception 'Run this script as the database owner' using errcode = '42501';
  end if;
  select count(*), min(u.id::text)::uuid, min(u.email_confirmed_at)
    into matches, target_id, confirmed
    from auth.users u, pg_temp.anchor_admin_target t
    where lower(u.email) = lower(btrim(t.email)) and btrim(t.email) <> '';
  if matches <> 1 then
    raise exception 'Expected exactly one registered account for the supplied email';
  end if;
  if confirmed is null then
    raise exception 'Confirm the account email before granting administrator access';
  end if;
  insert into private.admin_members(user_id) values (target_id) on conflict (user_id) do nothing;
end;
$$;
commit;
\echo 'Administrator membership granted to the confirmed account.'
