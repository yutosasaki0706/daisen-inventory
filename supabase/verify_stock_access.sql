begin;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $test$
declare i public.inventory%rowtype; changed public.inventory%rowtype; req uuid:=gen_random_uuid();
begin
select * into i from public.inventory where deleted_at is null and qty < 99999999 limit 1;
select * into changed from public.adjust_inventory(i.id,1,'access verification',req);
perform public.adjust_inventory(i.id,1,'access verification',req);
if (select qty from public.inventory where id=i.id) <> i.qty+1 then raise exception 'duplicate adjustment'; end if;
perform public.adjust_inventory(i.id,-1);
if (select qty from public.inventory where id=i.id) <> i.qty then raise exception 'stock mismatch'; end if;
begin
perform public.update_inventory_item(i.id,i.ddk,'not allowed',i.category,i.min,i.unit,i.version);
raise exception 'anonymous edit allowed';
exception when insufficient_privilege then null; end;
begin
update public.inventory set name='not allowed' where id=i.id;
raise exception 'direct edit allowed';
exception when insufficient_privilege then null; end;
begin
perform public.archive_inventory_item(i.id,i.version);
raise exception 'archive allowed';
exception when insufficient_privilege then null; end;
end $test$;
reset role;
select set_config('request.jwt.claims',(select jsonb_build_object('role','authenticated','sub',user_id)::text from public.app_users where active and role='admin' limit 1),true);
update public.app_users set role='editor' where user_id=auth.uid();
set local role authenticated;
do $test$
declare i public.inventory%rowtype;
begin
select * into i from public.inventory where deleted_at is null and qty<99999999 limit 1;
perform public.adjust_inventory(i.id,1);
begin
update public.inventory set name='not allowed' where id=i.id;
raise exception 'editor direct edit allowed';
exception when insufficient_privilege then null; end;
begin
update public.inventory set deleted_at=now() where id=i.id;
raise exception 'editor delete allowed';
exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
