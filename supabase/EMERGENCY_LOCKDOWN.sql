-- Run this first if the current public app must be locked immediately.
-- The existing app will stop reading and writing until the secure migration
-- and authenticated frontend are deployed.
begin;
revoke all on table public.inventory from public, anon;
revoke all on table public.history from public, anon;
alter table public.inventory enable row level security;
alter table public.history enable row level security;
commit;
