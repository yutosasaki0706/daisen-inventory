begin;

-- Legacy rows may contain an empty-string DDK number. A quantity-only UPDATE
-- must not normalize untouched product fields, otherwise the write is
-- incorrectly rejected as a simultaneous stock and product-information edit.
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

  if tg_op = 'INSERT' then
    new.name := btrim(new.name);
    new.category := btrim(new.category);
    new.unit := btrim(new.unit);
    new.ddk := nullif(btrim(new.ddk), '');
  else
    -- Normalize only fields explicitly changed by the caller. PostgreSQL fills
    -- NEW with the full row even for `SET qty = ...`; normalizing every field
    -- here made a legacy empty DDK look like an unrelated product edit.
    if new.name is distinct from old.name then
      new.name := btrim(new.name);
    end if;
    if new.category is distinct from old.category then
      new.category := btrim(new.category);
    end if;
    if new.unit is distinct from old.unit then
      new.unit := btrim(new.unit);
    end if;
    if new.ddk is distinct from old.ddk then
      new.ddk := nullif(btrim(new.ddk), '');
    end if;
  end if;

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

  if nullif(btrim(new.ddk), '') is not null and exists (
    select 1 from public.inventory duplicate
    where duplicate.deleted_at is null
      and nullif(btrim(duplicate.ddk), '') is not null
      and lower(btrim(duplicate.ddk)) = lower(btrim(new.ddk))
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

revoke all on function private.prepare_inventory_write()
  from public, anon, authenticated, service_role;

commit;
