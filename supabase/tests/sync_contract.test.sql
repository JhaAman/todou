begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

create function pg_temp.task_registers(p_title text, p_stamp text, p_bucket text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', jsonb_build_object('stamp', p_stamp, 'value', p_title),
    'schedule', jsonb_build_object('stamp', p_stamp, 'value', jsonb_build_object('bucket', p_bucket, 'due_date', null)),
    'priority', jsonb_build_object('stamp', p_stamp, 'value', 'low'),
    'area', jsonb_build_object('stamp', p_stamp, 'value', 'personal'),
    'estimate', jsonb_build_object('stamp', p_stamp, 'value', null),
    'order', jsonb_build_object('stamp', p_stamp, 'value', 'V'),
    'completion', jsonb_build_object('stamp', p_stamp, 'value', null),
    'deletion', jsonb_build_object('stamp', p_stamp, 'value', null)
  );
$$;

create temporary table first_apply as
select *
from public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  1,
  jsonb_build_object(
    'title', jsonb_build_object('stamp', '0000000001000-000000-device-a', 'value', 'Review launch plan'),
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
  jsonb_array_length(public.bootstrap_tasks() -> 'tasks'),
  1,
  'bootstrap includes retained tombstones for long-offline devices'
);

do $apply$
begin
perform public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000006',
  '20000000-0000-4000-8000-000000000001',
  2,
  '{"schedule":{"stamp":"0000000004000-000000-device-a","value":{"bucket":"in_progress","due_date":null}}}'::jsonb
);
end;
$apply$;

select is(
  (select bucket from public.tasks where id = '20000000-0000-4000-8000-000000000001'),
  'in_progress',
  'schedule mutations accept the In Progress bucket'
);

select throws_ok(
  $$
    select * from public.apply_task_mutation(
      '10000000-0000-4000-8000-000000000007',
      '20000000-0000-4000-8000-000000000001',
      1,
      '{"title":{"stamp":"0000000005000-000000-device-a","value":"Legacy update"}}'::jsonb
    )
  $$,
  '22023',
  'legacy_in_progress_protocol',
  'legacy mutations cannot produce an In Progress snapshot'
);

select is(
  (
    select snapshot ->> 'title'
    from public.apply_task_mutation(
      '10000000-0000-4000-8000-000000000007',
      '20000000-0000-4000-8000-000000000001',
      2,
      '{"title":{"stamp":"0000000005000-000000-device-a","value":"Legacy update"}}'::jsonb
    )
  ),
  'Legacy update',
  'a rejected legacy mutation can retry with the same ID under protocol 2'
);

do $apply$
begin
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000002',
    2,
    pg_temp.task_registers('First active task', '0000000006000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'in_progress')
  );
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000009',
    '20000000-0000-4000-8000-000000000003',
    2,
    pg_temp.task_registers('Second active task', '0000000006001-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'in_progress')
  );
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000010',
    '20000000-0000-4000-8000-000000000004',
    2,
    pg_temp.task_registers('Third active task', '0000000006002-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'in_progress')
  );
end;
$apply$;

select is(
  (select count(*) from public.tasks where bucket = 'in_progress' and completed_at is null and deleted_at is null),
  3::bigint,
  'three active tasks can enter In Progress'
);

create temporary table capped_apply as
select *
from public.apply_task_mutation(
  '10000000-0000-4000-8000-000000000011',
  '20000000-0000-4000-8000-000000000005',
  2,
  pg_temp.task_registers('Fourth active task', '0000000007000-0000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'in_progress')
);

select is(
  (select snapshot ->> 'bucket' from capped_apply),
  'inbox',
  'a fourth concurrent admission is resolved back to Inbox'
);

select is(
  (select snapshot ->> 'schedule_clock' from capped_apply),
  '0000000007000-0000000001-00000000000000000000000000000000',
  'the fallback schedule clock wins the rejected In Progress register'
);

select is(
  (select count(*) from public.tasks where bucket = 'in_progress' and completed_at is null and deleted_at is null),
  3::bigint,
  'the remote In Progress count never exceeds three'
);

do $apply$
begin
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000014',
    '20000000-0000-4000-8000-000000000006',
    2,
    pg_temp.task_registers('Today source task', '0000000007100-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'today')
  );
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000015',
    '20000000-0000-4000-8000-000000000006',
    2,
    '{"schedule":{"stamp":"0000000007101-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","value":{"bucket":"today","due_date":"2026-07-30"}}}'::jsonb
  );
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000016',
    '20000000-0000-4000-8000-000000000006',
    2,
    '{"schedule":{"stamp":"0000000007500-0000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","value":{"bucket":"in_progress","due_date":"2026-07-30"}},"order":{"stamp":"0000000007500-0000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","value":"a0V"}}'::jsonb
  );
end;
$apply$;

select results_eq(
  $$ select bucket, due_date::text, order_key from public.tasks where id = '20000000-0000-4000-8000-000000000006' $$,
  $$ values ('today'::text, '2026-07-30'::text, 'V'::text) $$,
  'a full In Progress lane preserves a Today task schedule and ordering'
);

select results_eq(
  $$ select schedule_clock, order_clock from public.tasks where id = '20000000-0000-4000-8000-000000000006' $$,
  $$ values ('0000000007500-0000000001-00000000000000000000000000000000'::text, '0000000007500-0000000001-00000000000000000000000000000000'::text) $$,
  'the preserved source schedule and order win the rejected move clocks'
);

do $apply$
begin
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000012',
    '20000000-0000-4000-8000-000000000002',
    2,
    '{"schedule":{"stamp":"0000000008000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","value":{"bucket":"today","due_date":null}}}'::jsonb
  );
  perform public.apply_task_mutation(
    '10000000-0000-4000-8000-000000000013',
    '20000000-0000-4000-8000-000000000005',
    2,
    '{"schedule":{"stamp":"0000000008001-0000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","value":{"bucket":"in_progress","due_date":null}}}'::jsonb
  );
end;
$apply$;

select is(
  (select bucket from public.tasks where id = '20000000-0000-4000-8000-000000000005'),
  'in_progress',
  'a task can enter In Progress after another task leaves'
);

select is(
  public.bootstrap_tasks() ->> 'protocol_version',
  '2',
  'bootstrap advertises protocol 2'
);

select * from finish();
rollback;
