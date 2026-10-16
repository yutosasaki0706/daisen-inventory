begin;
select set_config('request.jwt.claims', (select jsonb_build_object('role','authenticated','sub',user_id)::text from public.app_users where active and role='admin' limit 1),true);
set local role authenticated;
do $test$
declare c text := 'test-'||gen_random_uuid(); i public.inventory%rowtype;
begin
perform public.create_inventory_category(c);
select * into i from public.create_inventory_item(null,'temporary verification',c,5,1,'個');
select * into i from public.update_inventory_item(i.id,null,'temporary edited',c,2,'個',i.version);
select * into i from public.adjust_inventory(i.id,1);
if i.qty<>6 then raise exception 'admin stock failed'; end if;
end $test$;
reset role;
update public.app_users set role='editor' where user_id=auth.uid();
set local role authenticated;
do $test$
begin
if private.can_edit_inventory() then raise exception 'editor can edit'; end if;
begin
perform public.create_inventory_category('must-not-create');
raise exception 'editor RPC allowed';
exception when insufficient_privilege then null; end;
begin
insert into public.categories(name) values('must-not-create');
raise exception 'editor direct insert allowed';
exception when insufficient_privilege then null; end;
begin
perform public.update_inventory_item('nonexistent',null,'test','test',1,'個',0);
raise exception 'editor edit RPC allowed';
exception when insufficient_privilege then null; end;
end $test$;
reset role;
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;
do $test$
begin
perform 1 from public.inventory limit 1;
perform 1 from public.history limit 1;
if has_table_privilege('anon','public.inventory','INSERT') or has_table_privilege('anon','public.inventory','UPDATE') or has_table_privilege('anon','public.categories','INSERT') then raise exception 'anon write privileges'; end if;
begin
perform public.adjust_inventory('nonexistent',1);
raise exception 'anon RPC allowed';
exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
