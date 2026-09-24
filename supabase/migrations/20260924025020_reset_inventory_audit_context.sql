begin;

-- Consume per-request audit metadata after each write so a later mutation in
-- the same transaction cannot reuse an idempotency key or note.
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

  perform set_config('app.inventory_request_id', '', true);
  perform set_config('app.inventory_note', '', true);
  return new;
end;
$$;

revoke all on function private.audit_inventory_write()
  from public, anon, authenticated, service_role;

commit;
