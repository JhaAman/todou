begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

select ok(
  (select relrowsecurity
     from pg_class
    where oid = 'public.applied_mutations'::regclass),
  'applied_mutations has row level security enabled'
);

select results_eq(
  $$
    select role_name, table_name, privilege
      from unnest(array['public', 'anon', 'authenticated']) role_name
      cross join unnest(array['applied_mutations', 'sync_changes', 'sync_head', 'tasks']) table_name
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) privilege
     where has_table_privilege(role_name, format('public.%I', table_name), privilege)
     order by role_name, table_name, privilege
  $$,
  $$
    values
      ('anon'::text, 'sync_changes'::text, 'SELECT'::text),
      ('anon'::text, 'sync_head'::text, 'SELECT'::text),
      ('anon'::text, 'tasks'::text, 'SELECT'::text),
      ('authenticated'::text, 'sync_changes'::text, 'SELECT'::text),
      ('authenticated'::text, 'sync_head'::text, 'SELECT'::text),
      ('authenticated'::text, 'tasks'::text, 'SELECT'::text)
  $$,
  'client roles have exactly the required table privileges'
);

set local role anon;
select throws_ok(
  format('truncate table public.%I', table_name),
  '42501',
  format('permission denied for table %s', table_name),
  format('anon cannot truncate %s', table_name)
)
from unnest(array['applied_mutations', 'sync_changes', 'sync_head', 'tasks']) table_name;
reset role;

set local role authenticated;
select throws_ok(
  format('truncate table public.%I', table_name),
  '42501',
  format('permission denied for table %s', table_name),
  format('authenticated cannot truncate %s', table_name)
)
from unnest(array['applied_mutations', 'sync_changes', 'sync_head', 'tasks']) table_name;
reset role;

set local role anon;
select is(
  (select duplicate
     from public.apply_task_mutation(
       '30000000-0000-4000-8000-000000000001',
       '40000000-0000-4000-8000-000000000001',
       1,
       '{"title":{"stamp":"0000000001000-000000-access-test","value":"Access boundary"}}'::jsonb
     )),
  false,
  'anon can apply a task mutation through the RPC'
);

select is(
  (public.bootstrap_tasks() ->> 'watermark')::bigint,
  1::bigint,
  'anon can bootstrap through the RPC'
);

select is(
  (select count(*)
     from public.pull_task_changes(
       (public.bootstrap_tasks() ->> 'epoch')::uuid,
       0,
       200
     )),
  1::bigint,
  'anon can pull task changes through the RPC'
);
reset role;

set local role authenticated;
select is(
  (select duplicate
     from public.apply_task_mutation(
       '30000000-0000-4000-8000-000000000001',
       '40000000-0000-4000-8000-000000000001',
       1,
       '{"title":{"stamp":"0000000001000-000000-access-test","value":"Access boundary"}}'::jsonb
     )),
  true,
  'authenticated can retry a task mutation through the RPC'
);

select is(
  (public.bootstrap_tasks() ->> 'watermark')::bigint,
  1::bigint,
  'authenticated can bootstrap through the RPC'
);

select is(
  (select count(*)
     from public.pull_task_changes(
       (public.bootstrap_tasks() ->> 'epoch')::uuid,
       0,
       200
     )),
  1::bigint,
  'authenticated can pull task changes through the RPC'
);
reset role;

select * from finish();
rollback;
