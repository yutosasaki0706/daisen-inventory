-- Run after the migration and first app_users admin registration.
-- This script is read-only: it raises an exception when a security invariant is missing.
do $$
declare
  missing text[] := array[]::text[];
begin
  if not (select relrowsecurity from pg_class where oid = 'public.inventory'::regclass) then
    missing := array_append(missing, 'inventory RLS');
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.history'::regclass) then
    missing := array_append(missing, 'history RLS');
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.categories'::regclass) then
    missing := array_append(missing, 'categories RLS');
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.app_users'::regclass) then
    missing := array_append(missing, 'app_users RLS');
  end if;

  if has_table_privilege('anon', 'public.inventory', 'SELECT')
     or has_table_privilege('anon', 'public.inventory', 'INSERT')
     or has_table_privilege('anon', 'public.inventory', 'UPDATE')
     or has_table_privilege('anon', 'public.inventory', 'DELETE') then
    missing := array_append(missing, 'anon inventory revocation');
  end if;
  if has_table_privilege('anon', 'public.history', 'SELECT')
     or has_table_privilege('anon', 'public.history', 'INSERT')
     or has_table_privilege('anon', 'public.history', 'UPDATE')
     or has_table_privilege('anon', 'public.history', 'DELETE') then
    missing := array_append(missing, 'anon history revocation');
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.inventory'::regclass
      and tgname = 'inventory_prepare_write' and not tgisinternal
  ) then
    missing := array_append(missing, 'inventory validation trigger');
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.inventory'::regclass
      and tgname = 'inventory_audit_write' and not tgisinternal
  ) then
    missing := array_append(missing, 'inventory audit trigger');
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.categories'::regclass
      and tgname = 'categories_prepare_write' and not tgisinternal
  ) then
    missing := array_append(missing, 'category validation trigger');
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'adjust_inventory', 'create_inventory_item', 'update_inventory_item',
        'archive_inventory_item', 'restore_inventory_item',
        'create_inventory_category', 'delete_inventory_category'
      )
      and p.prosecdef
  ) then
    missing := array_append(missing, 'public RPC security invoker');
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in (
        'inventory_role', 'is_inventory_user', 'can_edit_inventory',
        'is_inventory_admin', 'assert_inventory_role', 'inventory_actor_email',
        'prepare_inventory_write', 'audit_inventory_write', 'prepare_category_write'
      )
      and p.prosecdef
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting in ('search_path=', 'search_path=""')
      )
  ) then
    missing := array_append(missing, 'private function search_path');
  end if;

  if not exists (
    select 1 from public.app_users
    where active = true and role = 'admin'
  ) then
    missing := array_append(missing, 'active admin user');
  end if;

  if cardinality(missing) > 0 then
    raise exception 'Security verification failed: %', array_to_string(missing, ', ');
  end if;

  raise notice 'Security verification passed.';
end;
$$;
