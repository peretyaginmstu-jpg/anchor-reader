\set ON_ERROR_STOP on
begin;
create function pg_temp.check_true(value boolean, label text) returns void
language plpgsql as $$
begin
  if value is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;
create function pg_temp.check_error(statement text, expected text, label text) returns void
language plpgsql as $$
declare caught text;
begin
  begin execute statement; exception when others then caught := sqlstate; end;
  if caught is distinct from expected then
    raise exception 'FAIL: % (expected %, received %)', label, expected, coalesce(caught, 'success');
  end if;
  raise notice 'PASS: %', label;
end;
$$;

select pg_temp.check_true((select count(*) = 3 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relrowsecurity and (n.nspname, c.relname) in (('public','profiles'),('public','catalogue_books'),('private','admin_members'))), 'RLS is enabled on every application table');
select pg_temp.check_true((select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.prosecdef and p.proconfig @> array['search_path=""']), 'Every privileged function pins an empty search_path');
select pg_temp.check_true((select not bool_or(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('is_admin','admin_list_users')), 'Exposed RPC wrappers are security invoker');
select pg_temp.check_true((select count(*) = 5 from public.profiles), 'Existing Auth users are backfilled');
select pg_temp.check_true((select display_name = 'Kept on rerun' from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'Migration rerun preserves edited profiles');
select pg_temp.check_true((select count(*) = 2 from private.admin_members), 'Bootstrap is idempotent and migration preserves memberships');
insert into auth.users(id, email, raw_user_meta_data, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000006','new@example.test',jsonb_build_object('display_name', repeat('я',100), 'role','admin'),now()),
  ('00000000-0000-0000-0000-000000000007','invalid-name@example.test','{"display_name":["wrong"]}',now());
select pg_temp.check_true((select char_length(display_name) = 80 from public.profiles where id = '00000000-0000-0000-0000-000000000006'), 'Signup trigger safely caps Unicode display names');
select pg_temp.check_true((select display_name = '' from public.profiles where id = '00000000-0000-0000-0000-000000000007'), 'Malformed metadata does not block profile creation');
insert into public.catalogue_books(id,title,author,chapters,total_words,published) values
  ('published','Published','Author','[{"title":"One","paragraphs":["Раз два три."]}]',3,true),
  ('draft','Draft','Author','[{"title":"One","paragraphs":["Черновик текста."]}]',2,false);

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.check_true((select array_agg(id) = array['published'] from public.catalogue_books), 'Anonymous visitors see only published books');
select pg_temp.check_error('select * from public.profiles','42501','Anonymous visitors cannot read profiles');
select pg_temp.check_error('select public.is_admin()','42501','Anonymous callers cannot execute role RPC');
select pg_temp.check_error('select * from public.admin_list_users()','42501','Anonymous callers cannot list users');
select pg_temp.check_error('select * from private.admin_members','42501','Anonymous callers cannot read membership');
select pg_temp.check_error($q$insert into public.catalogue_books(id,title,chapters,total_words) values ('anon','No','[{"title":"A","paragraphs":["word"]}]',1)$q$,'42501','Anonymous callers cannot insert books');
select pg_temp.check_error($q$update public.catalogue_books set title='No' where id='published'$q$,'42501','Anonymous callers cannot update books');
select pg_temp.check_error($q$delete from public.catalogue_books where id='published'$q$,'42501','Anonymous callers cannot delete books');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select pg_temp.check_true(not public.is_admin(), 'First registered user and forged metadata never grant admin');
select pg_temp.check_true((select count(*) = 1 and min(display_name) = 'Kept on rerun' from public.profiles), 'Reader sees only their own profile');
with changed as (update public.profiles set display_name='Новое имя' where id=auth.uid() returning display_name)
  select pg_temp.check_true((select count(*) = 1 and min(display_name) = 'Новое имя' from changed), 'Reader can update their own display name');
with changed as (update public.profiles set display_name='Stolen' where id='00000000-0000-0000-0000-000000000003' returning id)
  select pg_temp.check_true((select count(*) = 0 from changed), 'Updating another profile matches no rows');
select pg_temp.check_error($q$update public.profiles set id='00000000-0000-0000-0000-000000000003' where id=auth.uid()$q$,'42501','Profile identity cannot be changed');
select pg_temp.check_error('update public.profiles set created_at=now() where id=auth.uid()','42501','Profile creation timestamp cannot be changed');
select pg_temp.check_error('update public.profiles set display_name=repeat(''x'',81) where id=auth.uid()','23514','Oversized display name is rejected');
select pg_temp.check_error('insert into public.profiles(id) values (auth.uid())','42501','Profiles cannot be self-inserted');
select pg_temp.check_error('delete from public.profiles where id=auth.uid()','42501','Profiles cannot be deleted through Data API');
select pg_temp.check_error('select * from auth.users','42501','Reader cannot query Auth users directly');
select pg_temp.check_error('select * from public.admin_list_users()','42501','Reader is rejected by admin RPC with 42501');
select pg_temp.check_error('select * from private.admin_members','42501','Reader cannot inspect membership table');
select pg_temp.check_error('insert into private.admin_members(user_id) values (auth.uid())','42501','Reader cannot self-promote');
select pg_temp.check_true((select array_agg(id) = array['published'] from public.catalogue_books), 'Signed-in reader cannot read drafts');
select pg_temp.check_error($q$insert into public.catalogue_books(id,title,chapters,total_words) values ('reader','No','[{"title":"A","paragraphs":["word"]}]',1)$q$,'42501','Reader book insert is rejected by RLS');
with changed as (update public.catalogue_books set title='Hacked' where id='published' returning id)
  select pg_temp.check_true((select count(*) = 0 from changed), 'Reader update of published book matches no rows');
with removed as (delete from public.catalogue_books where id='published' returning id)
  select pg_temp.check_true((select count(*) = 0 from removed), 'Reader deletion of published book matches no rows');

select set_config('request.jwt.claim.sub','',true);
select pg_temp.check_true(not public.is_admin() and (select count(*) = 0 from public.profiles), 'Missing JWT identity grants no private access');
select pg_temp.check_error('select * from public.admin_list_users()','42501','Missing identity cannot list users');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
select pg_temp.check_true(public.is_admin(), 'Confirmed bootstrapped administrator is recognized');
select pg_temp.check_true((select count(*) = 2 from public.catalogue_books), 'Administrator can read drafts and published books');
select pg_temp.check_true((select count(*) = 1 from public.profiles), 'Administrator does not gain unrestricted direct profile reads');
select pg_temp.check_true((select count(*) = 7 and count(*) filter (where is_admin) = 2 from public.admin_list_users()), 'Administrator RPC returns registered users and effective roles');
select pg_temp.check_true((select bool_and(not (to_jsonb(u) ? 'encrypted_password')) from public.admin_list_users() u), 'Admin RPC never returns password hashes');
select pg_temp.check_error('insert into private.admin_members(user_id) values (''00000000-0000-0000-0000-000000000003'')','42501','Browser administrator cannot promote another user');
select pg_temp.check_error('delete from private.admin_members where user_id=auth.uid()','42501','Browser administrator cannot change memberships');
with inserted as (insert into public.catalogue_books(id,title,author,year,source_url,chapters,total_words)
  values ('new-book','New','Writer',2026,'https://example.test/book?q=one','[{"title":"Part","paragraphs":["A new book."]}]',3) returning id,published)
  select pg_temp.check_true((select count(*) = 1 and bool_and(not published) from inserted), 'Administrator insert succeeds and defaults to draft');
with changed as (update public.catalogue_books set title='Edited',published=true where id='new-book' returning title,updated_at,created_at)
  select pg_temp.check_true((select count(*) = 1 and bool_and(title='Edited' and updated_at>created_at) from changed), 'Administrator update publishes and refreshes server timestamp');
with upserted as (insert into public.catalogue_books(id,title,chapters,total_words,published)
  values ('new-book','Upserted','[{"title":"Part","paragraphs":["Changed text."]}]',2,false)
  on conflict(id) do update set id=excluded.id,title=excluded.title,chapters=excluded.chapters,total_words=excluded.total_words,published=excluded.published returning title)
  select pg_temp.check_true((select count(*)=1 and min(title)='Upserted' from upserted), 'Admin upsert uses the same Data API column grants');
select pg_temp.check_error('update public.catalogue_books set created_at=now() where id=''new-book''','42501','Creation timestamp is server-owned');
select pg_temp.check_error('update public.catalogue_books set updated_at=now() where id=''new-book''','42501','Update timestamp is server-owned');
select pg_temp.check_error('update public.catalogue_books set title='''' where id=''new-book''','23514','Empty book title is rejected');
select pg_temp.check_error('update public.catalogue_books set title=repeat('' '',241)||''a'' where id=''new-book''','23514','Whitespace padding cannot bypass title size limit');
select pg_temp.check_error('update public.catalogue_books set source_url=''javascript:alert(1)'' where id=''new-book''','23514','Unsafe source URL is rejected');
select pg_temp.check_error('update public.catalogue_books set source_url=''http://example.test'' where id=''new-book''','23514','HTTP source URL is rejected');
select pg_temp.check_error('update public.catalogue_books set total_words=0 where id=''new-book''','23514','Invalid word count is rejected');
select pg_temp.check_error('update public.catalogue_books set chapters=''[]'' where id=''new-book''','23514','Empty chapter list is rejected');
select pg_temp.check_error('update public.catalogue_books set chapters=''[42]'' where id=''new-book''','23514','Malformed chapter is rejected as a constraint violation');
select pg_temp.check_error($q$update public.catalogue_books set chapters='[{"title":"A","paragraphs":[42]}]' where id='new-book'$q$,'23514','Non-string paragraph is rejected');
select pg_temp.check_error($q$update public.catalogue_books set chapters='[{"title":"A","paragraphs":["   "]}]' where id='new-book'$q$,'23514','Whitespace-only paragraph is rejected');
select pg_temp.check_error($q$update public.catalogue_books set chapters='[{"title":"A","paragraphs":["text"],"html":"<script>"}]' where id='new-book'$q$,'23514','Unexpected chapter fields are rejected');
select pg_temp.check_error($q$update public.catalogue_books set chapters=jsonb_build_array(jsonb_build_object('title','A','paragraphs',jsonb_build_array(repeat('a',200001)))) where id='new-book'$q$,'23514','Oversized paragraph is rejected');
select pg_temp.check_error($q$update public.catalogue_books set chapters=jsonb_build_array(jsonb_build_object('title','A','paragraphs',jsonb_build_array(repeat('a',20971521)))) where id='new-book'$q$,'23514','Oversized book JSON is rejected');
with removed as (delete from public.catalogue_books where id='new-book' returning id)
  select pg_temp.check_true((select count(*) = 1 from removed), 'Administrator can delete a catalogue book');

reset role;
select pg_temp.check_true((select display_name='Other' from public.profiles where id='00000000-0000-0000-0000-000000000003'), 'Rejected profile write left the other user unchanged');
select pg_temp.check_true((select title='Published' from public.catalogue_books where id='published'), 'Rejected reader writes left the book unchanged');
update auth.users set email_confirmed_at=null where id='00000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.check_true(not public.is_admin(), 'Removing email confirmation disables existing admin membership');
select pg_temp.check_error('select * from public.admin_list_users()','42501','Unconfirmed member cannot list users');
reset role;
update auth.users set email_confirmed_at=now() where id='00000000-0000-0000-0000-000000000002';
delete from private.admin_members where user_id='00000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.check_true(not public.is_admin(), 'Revoking membership takes effect without replacing the JWT');
select pg_temp.check_error('select * from public.admin_list_users()','42501','Revoked administrator cannot list users');
reset role;
set local role service_role;
select pg_temp.check_true((select count(*)=2 from public.catalogue_books), 'Trusted service role retains catalogue access');
select pg_temp.check_error('insert into private.admin_members(user_id) values (''00000000-0000-0000-0000-000000000003'')','42501','Service role cannot bypass the owner-only bootstrap operation');
reset role;
delete from auth.users where id='00000000-0000-0000-0000-000000000005';
select pg_temp.check_true(not exists(select 1 from public.profiles where id='00000000-0000-0000-0000-000000000005') and not exists(select 1 from private.admin_members where user_id='00000000-0000-0000-0000-000000000005'), 'Deleting an Auth user cascades profile and membership');
rollback;
