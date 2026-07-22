revoke all privileges on table public.tasks, public.sync_changes, public.sync_head
from public, anon, authenticated;

grant select on table public.tasks, public.sync_changes, public.sync_head
to anon, authenticated;
