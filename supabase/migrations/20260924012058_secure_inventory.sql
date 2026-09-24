-- Generated with Supabase CLI; reviewed for Supabase Postgres and PostgREST.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Only users listed here may read application data.
create table if not exists public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_users_email_lower_key
  on public.app_users (lower(email));

-- Categories are database records rather than per-device localStorage values.
create table if not exists public.categories (
  name text primary key,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);

insert into public.categories (name, sort_order)
select category, row_number() over (order by category)::integer
from (
  select distinct trim(category) as category
  from public.inventory
  where nullif(trim(category), '') is not null
) existing
on conflict (name) do nothing;

-- Concurrency, soft deletion, and server-owned audit metadata.
alter table public.inventory add column if not exists version bigint not null default 0;
alter table public.inventory add column if not exists created_at timestamptz not null default now();
alter table public.inventory add column if not exists updated_at timestamptz not null default now();
alter table public.inventory add column if not exists updated_by uuid;
alter table public.inventory add column if not exists deleted_at timestamptz;
alter table public.inventory add column if not exists deleted_by uuid;

alter table public.history add column if not exists action text not null default 'stock_adjustment';
alter table public.history add column if not exists quantity_before integer;
alter table public.history add column if not exists quantity_after integer;
alter table public.history add column if not exists actor_id uuid;
alter table public.history add column if not exists actor_email text;
alter table public.history add column if not exists request_id uuid;
alter table public.history add column if not exists note text;
alter table public.history add column if not exists details jsonb not null default '{}'::jsonb;
alter table public.history add column if not exists created_at timestamptz not null default now();

update public.history
set action = case
  when delta > 0 then 'stock_in'
  when delta < 0 then 'stock_out'
  else 'stock_adjustment'
end
where action = 'stock_adjustment';

create unique index if not exists history_request_id_key
  on public.history (request_id)
  where request_id is not null;
create index if not exists history_created_at_idx on public.history (created_at desc);
create index if not exists history_item_created_at_idx on public.history (item_id, created_at desc);
create index if not exists history_action_created_at_idx on public.history (action, created_at desc);
create index if not exists history_actor_id_idx on public.history (actor_id) where actor_id is not null;
create index if not exists inventory_active_category_idx on public.inventory (category, name) where deleted_at is null;
create index if not exists inventory_category_idx on public.inventory (category);
create index if not exists inventory_updated_by_idx on public.inventory (updated_by) where updated_by is not null;
create index if not exists inventory_deleted_by_idx on public.inventory (deleted_by) where deleted_by is not null;
create index if not exists categories_created_by_idx on public.categories (created_by) where created_by is not null;
create unique index if not exists inventory_active_ddk_lower_key
  on public.inventory (lower(trim(ddk)))
  where deleted_at is null and nullif(trim(ddk), '') is not null;
create unique index if not exists categories_name_lower_key
  on public.categories (lower(name));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_qty_nonnegative'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_qty_nonnegative check (qty >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_min_nonnegative'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_min_nonnegative check (min >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_name_length'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_name_length check (char_length(name) between 1 and 120) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_unit_length'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_unit_length check (char_length(unit) between 1 and 20) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_ddk_length'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_ddk_length check (ddk is null or char_length(ddk) <= 80) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_category_length'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_category_length check (char_length(category) between 1 and 50) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'history_note_length'
      and conrelid = 'public.history'::regclass
  ) then
    alter table public.history
      add constraint history_note_length check (note is null or char_length(note) <= 200) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'history_action_allowed'
      and conrelid = 'public.history'::regclass
  ) then
    alter table public.history
      add constraint history_action_allowed
      check (action in ('create', 'edit', 'stock_in', 'stock_out', 'stock_adjustment', 'archive', 'restore'))
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_category_fkey'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_category_fkey foreign key (category)
      references public.categories(name) on update cascade on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'categories_name_length'
      and conrelid = 'public.categories'::regclass
  ) then
    alter table public.categories
      add constraint categories_name_length check (char_length(name) between 1 and 50) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_updated_by_fkey'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_updated_by_fkey foreign key (updated_by)
      references auth.users(id) on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_deleted_by_fkey'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_deleted_by_fkey foreign key (deleted_by)
      references auth.users(id) on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'history_actor_id_fkey'
      and conrelid = 'public.history'::regclass
  ) then
    alter table public.history
      add constraint history_actor_id_fkey foreign key (actor_id)
      references auth.users(id) on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'categories_created_by_fkey'
      and conrelid = 'public.categories'::regclass
  ) then
    alter table public.categories
      add constraint categories_created_by_fkey foreign key (created_by)
      references auth.users(id) on delete set null not valid;
  end if;
end $$;

-- Private authorization helpers. They are not reachable through the Data API.
create or replace function private.inventory_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.app_users
  where user_id = (select auth.uid()) and active = true
  limit 1;
$$;

create or replace function private.is_inventory_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.inventory_role() is not null;
$$;

create or replace function private.can_edit_inventory()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.inventory_role() in ('editor', 'admin');
$$;

create or replace function private.is_inventory_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.inventory_role() = 'admin';
$$;

create or replace function private.assert_inventory_role(allowed_roles text[])
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  found_role text;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'ログインが必要です。';
  end if;
  select role into found_role
  from public.app_users
  where user_id = caller_id and active = true;
  if found_role is null or not (found_role = any(allowed_roles)) then
    raise exception using errcode = '42501', message = 'この操作を行う権限がありません。';
  end if;
  return found_role;
end;
$$;

create or replace function private.inventory_actor_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select email from auth.users where id = (select auth.uid());
$$;

revoke all on function private.inventory_role() from public, anon, authenticated, service_role;
revoke all on function private.is_inventory_user() from public, anon, authenticated, service_role;
revoke all on function private.can_edit_inventory() from public, anon, authenticated, service_role;
revoke all on function private.is_inventory_admin() from public, anon, authenticated, service_role;
revoke all on function private.assert_inventory_role(text[]) from public, anon, authenticated, service_role;
revoke all on function private.inventory_actor_email() from public, anon, authenticated, service_role;

grant usage on schema private to authenticated;
grant execute on function private.is_inventory_user() to authenticated;
grant execute on function private.can_edit_inventory() to authenticated;
grant execute on function private.is_inventory_admin() to authenticated;
grant execute on function private.assert_inventory_role(text[]) to authenticated;

-- The before trigger owns all identity, version, and timestamp fields.
create or replace function private.prepare_inventory_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  maintenance boolean := session_user in ('postgres', 'supabase_admin', 'supabase_auth_admin') or jwt_role = 'service_role';
begin
  if caller_id is not null then
    select role into caller_role
    from public.app_users
    where user_id = caller_id and active = true;
  elsif maintenance then
    caller_role := 'admin';
  else
    raise exception using errcode = '42501', message = 'ログインが必要です。';
  end if;

  if caller_role not in ('editor', 'admin') then
    raise exception using errcode = '42501', message = 'この操作を行う権限がありません。';
  end if;

  -- Auth user deletion may clear only audit foreign keys via ON DELETE SET NULL.
  -- Do not turn that referential cleanup into a product edit or version bump.
  if maintenance and tg_op = 'UPDATE'
     and new.id is not distinct from old.id
     and new.ddk is not distinct from old.ddk
     and new.name is not distinct from old.name
     and new.category is not distinct from old.category
     and new.qty is not distinct from old.qty
     and new.min is not distinct from old.min
     and new.unit is not distinct from old.unit
     and new.version is not distinct from old.version
     and new.created_at is not distinct from old.created_at
     and new.updated_at is not distinct from old.updated_at
     and new.deleted_at is not distinct from old.deleted_at
     and (
       new.updated_by is distinct from old.updated_by or
       new.deleted_by is distinct from old.deleted_by
     ) then
    return new;
  end if;

  new.name := trim(new.name);
  new.category := trim(new.category);
  new.unit := trim(new.unit);
  new.ddk := nullif(trim(new.ddk), '');

  if new.name is null or char_length(new.name) not between 1 and 120 then
    raise exception using errcode = '22023', message = '商品名は1文字以上120文字以内で入力してください。';
  end if;
  if new.category is null or char_length(new.category) not between 1 and 50 then
    raise exception using errcode = '22023', message = '分野は1文字以上50文字以内で指定してください。';
  end if;
  if new.unit is null or char_length(new.unit) not between 1 and 20 then
    raise exception using errcode = '22023', message = '単位は1文字以上20文字以内で入力してください。';
  end if;
  if new.ddk is not null and char_length(new.ddk) > 80 then
    raise exception using errcode = '22023', message = 'DDK番号は80文字以内で入力してください。';
  end if;
  if new.qty is null or new.min is null or new.qty < 0 or new.min < 0
     or new.qty > 100000000 or new.min > 100000000 then
    raise exception using errcode = '22023', message = '在庫数または警告ラインが正しくありません。';
  end if;

  if new.ddk is not null and exists (
    select 1 from public.inventory duplicate
    where duplicate.deleted_at is null
      and lower(duplicate.ddk) = lower(new.ddk)
      and (tg_op = 'INSERT' or duplicate.id <> new.id)
  ) then
    raise exception using errcode = '23505', message = '同じDDK番号の商品がすでにあります。';
  end if;

  if tg_op = 'INSERT' then
    -- API callers cannot choose predictable or colliding identifiers. Trusted
    -- maintenance sessions may retain explicit IDs for controlled imports.
    new.id := case
      when maintenance and nullif(new.id, '') is not null then new.id
      else gen_random_uuid()::text
    end;
    new.version := 0;
    new.created_at := now();
    new.updated_at := now();
    new.updated_by := caller_id;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception using errcode = '22023', message = '商品IDは変更できません。';
  end if;
  if new.deleted_at is distinct from old.deleted_at and caller_role <> 'admin' then
    raise exception using errcode = '42501', message = '商品の削除と復元は管理者だけが実行できます。';
  end if;
  if new.deleted_at is distinct from old.deleted_at and (
    new.qty is distinct from old.qty or
    new.ddk is distinct from old.ddk or
    new.name is distinct from old.name or
    new.category is distinct from old.category or
    new.min is distinct from old.min or
    new.unit is distinct from old.unit
  ) then
    raise exception using errcode = '22023', message = '商品情報の変更と削除・復元は同時に実行できません。';
  end if;
  if new.qty is distinct from old.qty and (
    new.ddk is distinct from old.ddk or
    new.name is distinct from old.name or
    new.category is distinct from old.category or
    new.min is distinct from old.min or
    new.unit is distinct from old.unit
  ) then
    raise exception using errcode = '22023', message = '在庫数と商品情報は同時に変更できません。';
  end if;

  if new.ddk is not distinct from old.ddk
     and new.name is not distinct from old.name
     and new.category is not distinct from old.category
     and new.qty is not distinct from old.qty
     and new.min is not distinct from old.min
     and new.unit is not distinct from old.unit
     and new.deleted_at is not distinct from old.deleted_at then
    new.version := old.version;
    new.created_at := old.created_at;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    new.deleted_by := old.deleted_by;
    return new;
  end if;

  new.version := old.version + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  new.updated_by := caller_id;
  if new.deleted_at is distinct from old.deleted_at then
    new.deleted_by := case when new.deleted_at is null then null else caller_id end;
  else
    new.deleted_by := old.deleted_by;
  end if;
  return new;
end;
$$;

-- Every accepted inventory write creates an immutable history row in the same transaction.
create or replace function private.audit_inventory_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_action text;
  audit_delta integer := 0;
  before_quantity integer;
  after_quantity integer;
  audit_details jsonb := '{}'::jsonb;
  request_text text := nullif(current_setting('app.inventory_request_id', true), '');
  audit_request_id uuid;
  audit_note text := nullif(current_setting('app.inventory_note', true), '');
begin
  if tg_op = 'UPDATE'
     and new.ddk is not distinct from old.ddk
     and new.name is not distinct from old.name
     and new.category is not distinct from old.category
     and new.qty is not distinct from old.qty
     and new.min is not distinct from old.min
     and new.unit is not distinct from old.unit
     and new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;

  if request_text is not null then
    audit_request_id := request_text::uuid;
  end if;

  if tg_op = 'INSERT' then
    audit_action := 'create';
    audit_delta := new.qty;
    before_quantity := 0;
    after_quantity := new.qty;
  else
    before_quantity := old.qty;
    after_quantity := new.qty;
    if new.deleted_at is distinct from old.deleted_at then
      audit_action := case when new.deleted_at is null then 'restore' else 'archive' end;
    elsif new.qty is distinct from old.qty then
      audit_delta := new.qty - old.qty;
      audit_action := case when audit_delta > 0 then 'stock_in' else 'stock_out' end;
    else
      audit_action := 'edit';
      audit_details := jsonb_build_object(
        'before', jsonb_build_object(
          'ddk', old.ddk, 'name', old.name, 'category', old.category,
          'min', old.min, 'unit', old.unit
        ),
        'after', jsonb_build_object(
          'ddk', new.ddk, 'name', new.name, 'category', new.category,
          'min', new.min, 'unit', new.unit
        )
      );
    end if;
  end if;

  insert into public.history (
    item_id, name, ddk, category, delta, unit, action,
    quantity_before, quantity_after, actor_id, actor_email,
    request_id, note, details
  ) values (
    new.id, new.name, coalesce(new.ddk, ''), new.category, audit_delta, new.unit,
    audit_action, before_quantity, after_quantity, auth.uid(),
    private.inventory_actor_email(), audit_request_id, audit_note, audit_details
  );
  return new;
end;
$$;

-- Category audit metadata and ordering are server-owned even for direct REST writes.
create or replace function private.prepare_category_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  maintenance boolean := session_user in ('postgres', 'supabase_admin', 'supabase_auth_admin') or jwt_role = 'service_role';
begin
  if caller_id is not null then
    select role into caller_role
    from public.app_users
    where user_id = caller_id and active = true;
  elsif maintenance then
    caller_role := 'admin';
  else
    raise exception using errcode = '42501', message = 'ログインが必要です。';
  end if;
  if caller_role not in ('editor', 'admin') then
    raise exception using errcode = '42501', message = 'この操作を行う権限がありません。';
  end if;

  new.name := trim(new.name);
  if new.name is null or char_length(new.name) not between 1 and 50 then
    raise exception using errcode = '22023', message = '分野名は1文字以上50文字以内で入力してください。';
  end if;
  new.sort_order := coalesce((select max(sort_order) + 1 from public.categories), 1);
  new.created_at := now();
  new.created_by := caller_id;
  return new;
end;
$$;

revoke all on function private.prepare_inventory_write() from public, anon, authenticated, service_role;
revoke all on function private.audit_inventory_write() from public, anon, authenticated, service_role;
revoke all on function private.prepare_category_write() from public, anon, authenticated, service_role;

drop trigger if exists inventory_prepare_write on public.inventory;
drop trigger if exists inventory_audit_write on public.inventory;
create trigger inventory_prepare_write
  before insert or update on public.inventory
  for each row execute function private.prepare_inventory_write();
create trigger inventory_audit_write
  after insert or update on public.inventory
  for each row execute function private.audit_inventory_write();
drop trigger if exists categories_prepare_write on public.categories;
create trigger categories_prepare_write
  before insert on public.categories
  for each row execute function private.prepare_category_write();

-- Replace every old policy so no permissive anonymous policy survives.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('inventory', 'history', 'categories', 'app_users')
  loop
    execute format('drop policy %I on %I.%I', policy_record.policyname, policy_record.schemaname, policy_record.tablename);
  end loop;
end $$;

alter table public.inventory enable row level security;
alter table public.history enable row level security;
alter table public.categories enable row level security;
alter table public.app_users enable row level security;

revoke all on table public.inventory from public, anon, authenticated;
revoke all on table public.history from public, anon, authenticated;
revoke all on table public.categories from public, anon, authenticated;
revoke all on table public.app_users from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select, insert, update on table public.inventory to authenticated;
grant select on table public.history to authenticated;
grant select, insert, delete on table public.categories to authenticated;
grant select on table public.app_users to authenticated;

create policy inventory_select_authorized
  on public.inventory for select to authenticated
  using (
    (select private.is_inventory_user())
    and (deleted_at is null or (select private.is_inventory_admin()))
  );

create policy inventory_insert_editor
  on public.inventory for insert to authenticated
  with check ((select private.can_edit_inventory()) and deleted_at is null);

create policy inventory_update_editor
  on public.inventory for update to authenticated
  using (
    (select private.can_edit_inventory())
    and (deleted_at is null or (select private.is_inventory_admin()))
  )
  with check ((select private.can_edit_inventory()));

create policy history_select_authorized
  on public.history for select to authenticated
  using ((select private.is_inventory_user()));

create policy categories_select_authorized
  on public.categories for select to authenticated
  using ((select private.is_inventory_user()));

create policy categories_insert_editor
  on public.categories for insert to authenticated
  with check ((select private.can_edit_inventory()));

create policy categories_delete_admin
  on public.categories for delete to authenticated
  using ((select private.is_inventory_admin()));

create policy app_users_select_self
  on public.app_users for select to authenticated
  using (active = true and user_id = (select auth.uid()));

-- Remove legacy authorization helpers if an earlier draft was ever applied.
drop function if exists public.is_inventory_user();
drop function if exists public.current_inventory_role();
drop function if exists public.assert_inventory_role(text[]);
drop function if exists public.inventory_actor_email();

-- Public RPCs run as the signed-in caller and therefore cannot bypass RLS.
create or replace function public.adjust_inventory(
  p_item_id text,
  p_delta integer,
  p_note text default null,
  p_request_id uuid default gen_random_uuid()
)
returns public.inventory
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item_after public.inventory%rowtype;
  prior_item_id text;
begin
  perform private.assert_inventory_role(array['editor', 'admin']);
  p_request_id := coalesce(p_request_id, gen_random_uuid());
  if p_delta is null or p_delta = 0 or abs(p_delta::bigint) > 1000000 then
    raise exception using errcode = '22023', message = '入出庫数が正しくありません。';
  end if;
  if p_note is not null and char_length(p_note) > 200 then
    raise exception using errcode = '22023', message = 'メモは200文字以内で入力してください。';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select item_id into prior_item_id
  from public.history
  where request_id = p_request_id;
  if found then
    select * into item_after from public.inventory where id = prior_item_id;
    return item_after;
  end if;

  perform set_config('app.inventory_request_id', p_request_id::text, true);
  perform set_config('app.inventory_note', coalesce(trim(p_note), ''), true);
  update public.inventory
  set qty = qty + p_delta
  where id = p_item_id
    and deleted_at is null
    and qty + p_delta >= 0
  returning * into item_after;
  if not found then
    raise exception using errcode = '23514', message = '商品がないか、現在の在庫数を超えて出庫しようとしています。';
  end if;
  return item_after;
end;
$$;

create or replace function public.create_inventory_item(
  p_ddk text,
  p_name text,
  p_category text,
  p_qty integer,
  p_min integer,
  p_unit text,
  p_request_id uuid default gen_random_uuid()
)
returns public.inventory
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item_after public.inventory%rowtype;
  prior_item_id text;
begin
  perform private.assert_inventory_role(array['editor', 'admin']);
  p_request_id := coalesce(p_request_id, gen_random_uuid());
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 then
    raise exception using errcode = '22023', message = '商品名は1文字以上120文字以内で入力してください。';
  end if;
  if char_length(coalesce(p_ddk, '')) > 80 then
    raise exception using errcode = '22023', message = 'DDK番号は80文字以内で入力してください。';
  end if;
  if p_unit is null or char_length(trim(p_unit)) not between 1 and 20 then
    raise exception using errcode = '22023', message = '単位は1文字以上20文字以内で入力してください。';
  end if;
  if p_qty is null or p_min is null or p_qty < 0 or p_qty > 100000000 or p_min < 0 or p_min > 100000000 then
    raise exception using errcode = '22023', message = '在庫数または警告ラインが正しくありません。';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select item_id into prior_item_id
  from public.history
  where request_id = p_request_id;
  if found then
    select * into item_after from public.inventory where id = prior_item_id;
    return item_after;
  end if;

  perform set_config('app.inventory_request_id', p_request_id::text, true);
  perform set_config('app.inventory_note', '', true);
  insert into public.inventory (id, ddk, name, category, qty, min, unit)
  values (gen_random_uuid()::text, p_ddk, p_name, p_category, p_qty, p_min, p_unit)
  returning * into item_after;
  return item_after;
end;
$$;

create or replace function public.update_inventory_item(
  p_item_id text,
  p_ddk text,
  p_name text,
  p_category text,
  p_min integer,
  p_unit text,
  p_expected_version bigint
)
returns public.inventory
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item_after public.inventory%rowtype;
begin
  perform private.assert_inventory_role(array['editor', 'admin']);
  if p_expected_version is null then
    raise exception using errcode = '22023', message = '更新バージョンが必要です。';
  end if;
  update public.inventory
  set ddk = p_ddk, name = p_name, category = p_category, min = p_min, unit = p_unit
  where id = p_item_id and deleted_at is null and version = p_expected_version
  returning * into item_after;
  if not found then
    raise exception using errcode = '40001', message = '商品がないか、ほかの端末で更新されています。再読込してください。';
  end if;
  return item_after;
end;
$$;

create or replace function public.archive_inventory_item(
  p_item_id text,
  p_expected_version bigint
)
returns public.inventory
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item_after public.inventory%rowtype;
begin
  perform private.assert_inventory_role(array['admin']);
  if p_expected_version is null then
    raise exception using errcode = '22023', message = '更新バージョンが必要です。';
  end if;
  update public.inventory
  set deleted_at = now()
  where id = p_item_id and deleted_at is null and version = p_expected_version
  returning * into item_after;
  if not found then
    raise exception using errcode = '40001', message = '商品がないか、ほかの端末で更新されています。';
  end if;
  return item_after;
end;
$$;

create or replace function public.restore_inventory_item(p_item_id text)
returns public.inventory
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item_after public.inventory%rowtype;
begin
  perform private.assert_inventory_role(array['admin']);
  update public.inventory
  set deleted_at = null
  where id = p_item_id and deleted_at is not null
  returning * into item_after;
  if not found then
    raise exception using errcode = 'P0002', message = '復元対象の商品が見つかりません。';
  end if;
  return item_after;
end;
$$;

create or replace function public.create_inventory_category(p_name text)
returns public.categories
language plpgsql
security invoker
set search_path = ''
as $$
declare
  category_after public.categories%rowtype;
  clean_name text := trim(coalesce(p_name, ''));
begin
  perform private.assert_inventory_role(array['editor', 'admin']);
  if char_length(clean_name) not between 1 and 50 then
    raise exception using errcode = '22023', message = '分野名は1文字以上50文字以内で入力してください。';
  end if;
  if exists (select 1 from public.categories where lower(name) = lower(clean_name)) then
    raise exception using errcode = '23505', message = '同じ分野がすでにあります。';
  end if;
  insert into public.categories (name, sort_order, created_by)
  values (clean_name, coalesce((select max(sort_order) + 1 from public.categories), 1), auth.uid())
  returning * into category_after;
  return category_after;
end;
$$;

create or replace function public.delete_inventory_category(p_name text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.assert_inventory_role(array['admin']);
  if exists (select 1 from public.inventory where category = p_name) then
    raise exception using errcode = '23503', message = '商品が入っている分野は削除できません。';
  end if;
  delete from public.categories where name = p_name;
  if not found then
    raise exception using errcode = 'P0002', message = '分野が見つかりません。';
  end if;
end;
$$;

revoke all on function public.adjust_inventory(text, integer, text, uuid) from public, anon;
revoke all on function public.create_inventory_item(text, text, text, integer, integer, text, uuid) from public, anon;
revoke all on function public.update_inventory_item(text, text, text, text, integer, text, bigint) from public, anon;
revoke all on function public.archive_inventory_item(text, bigint) from public, anon;
revoke all on function public.restore_inventory_item(text) from public, anon;
revoke all on function public.create_inventory_category(text) from public, anon;
revoke all on function public.delete_inventory_category(text) from public, anon;

grant execute on function public.adjust_inventory(text, integer, text, uuid) to authenticated;
grant execute on function public.create_inventory_item(text, text, text, integer, integer, text, uuid) to authenticated;
grant execute on function public.update_inventory_item(text, text, text, text, integer, text, bigint) to authenticated;
grant execute on function public.archive_inventory_item(text, bigint) to authenticated;
grant execute on function public.restore_inventory_item(text) to authenticated;
grant execute on function public.create_inventory_category(text) to authenticated;
grant execute on function public.delete_inventory_category(text) to authenticated;

commit;
