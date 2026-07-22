alter table public.applied_mutations enable row level security;

revoke all privileges on table public.applied_mutations from public, anon, authenticated;
