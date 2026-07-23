begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

create temporary table first_apply as
select *
from public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  1,
  jsonb_build_object(
    'title', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'Review launch plan'),
    'description', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'https://example.com/launch'),
    'schedule', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', jsonb_build_object('bucket', 'inbox', 'due_date', null)),
    'priority', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'low'),
    'area', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'work'),
    'estimate', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 25),
    'order', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'a0V'),
    'completion', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', null),
    'deletion', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', null)
  )
);

select is(
  (select snapshot ->> 'title' from first_apply),
  'Review launch plan',
  'a local create produces the expected remote task'
);

select is(
  (select snapshot ->> 'description' from first_apply),
  'https://example.com/launch',
  'a description register is stored in the remote snapshot'
);

select is(
  (select seq from first_apply),
  1::bigint,
  'the transactional feed starts at one'
);

create temporary table duplicate_apply as
select *
from public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  1,
  jsonb_build_object(
    'title', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'Review launch plan'),
    'description', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'https://example.com/launch'),
    'schedule', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', jsonb_build_object('bucket', 'inbox', 'due_date', null)),
    'priority', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'low'),
    'area', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'work'),
    'estimate', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 25),
    'order', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'a0V'),
    'completion', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', null),
    'deletion', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', null)
  )
);

select ok(
  (select duplicate from duplicate_apply) and (select seq from duplicate_apply) = 1,
  'retrying a committed mutation returns its original result without another feed row'
);

select throws_ok(
  $$
    select * from public.apply_task_mutation(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      1,
      '{"title":{"stamp":"0000000001001-000000-device-a","value":"Different payload"}}'::jsonb
    )
  $$,
  '22023',
  'idempotency_mismatch',
  'reusing a mutation UUID for a different payload is rejected'
);

select throws_ok(
  $$
    select * from public.apply_task_mutation(
      '10000000-0000-4000-8000-000000000006',
      '20000000-0000-4000-8000-000000000001',
      1,
      '{"description":{"stamp":"0000000004000-000000-device-a","value":"\nnotes"}}'::jsonb
    )
  $$,
  '22023',
  'invalid_description_register',
  'descriptions with leading newline whitespace are rejected'
);

select throws_ok(
  $$
    select * from public.apply_task_mutation(
      '10000000-0000-4000-8000-000000000007',
      '20000000-0000-4000-8000-000000000001',
      1,
      '{"description":{"stamp":"0000000004000-000000-device-a","value":"\u3000notes"}}'::jsonb
    )
  $$,
  '22023',
  'invalid_description_register',
  'descriptions with leading Unicode whitespace are rejected'
);

do $apply$
begin
perform public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  1,
  '{"priority":{"stamp":"0000000002000-000000-device-b","value":"high"}}'::jsonb
);
end;
$apply$;

select results_eq(
  $$ select title, priority from public.tasks where id = '20000000-0000-4000-8000-000000000001' $$,
  $$ values ('Review launch plan'::text, 'high'::text) $$,
  'edits to a different register preserve the existing title'
);

do $apply$
begin
perform public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000001',
  1,
  '{"title":{"stamp":"0000000000500-000000-device-b","value":"Stale title"}}'::jsonb
);
end;
$apply$;

select is(
  (select title from public.tasks where id = '20000000-0000-4000-8000-000000000001'),
  'Review launch plan',
  'an older same-register edit cannot overwrite a newer value'
);

do $apply$
begin
perform public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000001',
  1,
  '{"deletion":{"stamp":"0000000003000-000000-device-b","value":"2026-07-20T20:00:00Z"}}'::jsonb
);
end;
$apply$;

do $apply$
begin
perform public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000001',
  1,
  '{"title":{"stamp":"0000000002500-000000-device-a","value":"Offline stale edit"}}'::jsonb
);
end;
$apply$;

select isnt(
  (select deleted_at from public.tasks where id = '20000000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'a stale edit does not clear the deletion tombstone'
);

select is(
  (select count(*) from public.pull_task_changes(
    (select epoch from public.sync_head where singleton),
    1,
    200
  )),
  4::bigint,
  'cursor pulls return every committed non-duplicate change after the cursor'
);

select is(
  (public.bootstrap_tasks() ->> 'watermark')::bigint,
  5::bigint,
  'bootstrap returns a watermark consistent with the feed head'
);

select is(
  (public.bootstrap_tasks() ->> 'description_register')::boolean,
  true,
  'bootstrap advertises description register support'
);

select is(
  jsonb_array_length(public.bootstrap_tasks() -> 'tasks'),
  1,
  'bootstrap includes retained tombstones for long-offline devices'
);

select * from finish();
rollback;
