begin;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $test$
declare
  cat text := 'verification-' || gen_random_uuid()::text;
  item public.inventory%rowtype;
  req uuid := gen_random_uuid();
  qty integer;
begin
  perform public.create_inventory_category(cat);
  select * into item from public.create_inventory_item(null, 'Verification only', cat, 10, 2, '個');
  perform public.adjust_inventory(item.id, 2, 'verification', req);
  perform public.adjust_inventory(item.id, 2, 'verification', req);
  select * into item from public.inventory where id=item.id;
  if item.qty <> 12 then raise exception 'idempotency failed'; end if;
  select * into item from public.update_inventory_item(item.id, null, 'Updated verification', cat, 3, '個', item.version);
  begin
    perform public.archive_inventory_item(item.id,item.version);
    raise exception 'anonymous archive unexpectedly permitted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.restore_inventory_item(item.id);
    raise exception 'anonymous restore unexpectedly permitted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.delete_inventory_category(cat);
    raise exception 'anonymous category delete unexpectedly permitted';
  exception when insufficient_privilege then null; end;
  begin
    update public.inventory set deleted_at=now() where id=item.id;
    raise exception 'direct archive unexpectedly permitted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.adjust_inventory(item.id,-1000);
    raise exception 'negative stock unexpectedly permitted';
  exception when check_violation then null; end;
  if has_table_privilege('anon','public.history','INSERT') or has_table_privilege('anon','public.history','UPDATE') or has_table_privilege('anon','public.history','DELETE') then
    raise exception 'history mutation exposed';
  end if;
  if has_table_privilege('anon','public.app_users','SELECT') then raise exception 'user directory exposed'; end if;
end $test$;
reset role;
rollback;
