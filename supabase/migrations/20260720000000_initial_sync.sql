create extension if not exists pgcrypto with schema extensions;

create table public.sync_head (
  singleton boolean primary key default true check (singleton),
  epoch uuid not null default gen_random_uuid(),
  last_seq bigint not null default 0 check (last_seq >= 0)
);

insert into public.sync_head (singleton) values (true)
on conflict (singleton) do nothing;

create table public.tasks (
  id uuid primary key,
  title text not null default '',
  bucket text not null default 'inbox' check (bucket in ('today', 'inbox')),
  priority text not null default 'low' check (priority in ('high', 'low')),
  area text not null default 'personal' check (area in ('personal', 'work')),
  due_date date,
  estimate_minutes integer check (estimate_minutes is null or estimate_minutes between 1 and 1440),
  order_key text not null default 'V',
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_version bigint not null default 0,
  title_clock text not null default '',
  schedule_clock text not null default '',
  priority_clock text not null default '',
  area_clock text not null default '',
  estimate_clock text not null default '',
  order_clock text not null default '',
  completion_clock text not null default '',
  deletion_clock text not null default '',
  check (char_length(title) <= 500),
  check (char_length(order_key) >= 1),
  check (order_key ~ '^[0-9A-Za-z]+$' and right(order_key, 1) <> '0')
);

create index tasks_active_bucket_priority_order_idx
  on public.tasks (bucket, priority, order_key collate "C", id)
  where completed_at is null and deleted_at is null;

create index tasks_logbook_idx
  on public.tasks (completed_at desc)
  where completed_at is not null and deleted_at is null;

create table public.sync_changes (
  seq bigint primary key check (seq > 0),
  epoch uuid not null,
  mutation_id uuid not null unique,
  task_id uuid not null,
  protocol_version integer not null default 1,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index sync_changes_epoch_seq_idx on public.sync_changes (epoch, seq);

create table public.applied_mutations (
  mutation_id uuid primary key,
  payload_hash text not null,
  result_seq bigint not null references public.sync_changes (seq),
  result_snapshot jsonb not null,
  applied_at timestamptz not null default now()
);

create or replace function public.apply_task_mutation(
  p_operation_id uuid,
  p_task_id uuid,
  p_protocol_version integer,
  p_registers jsonb
)
returns table (
  epoch uuid,
  seq bigint,
  snapshot jsonb,
  duplicate boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_epoch uuid;
  v_seq bigint;
  v_hash text;
  v_existing_hash text;
  v_existing_seq bigint;
  v_existing_snapshot jsonb;
  v_task public.tasks%rowtype;
  v_register jsonb;
  v_stamp text;
  v_value jsonb;
begin
  if p_protocol_version <> 1 then
    raise exception using errcode = '22023', message = 'protocol_mismatch';
  end if;

  if p_registers is null or jsonb_typeof(p_registers) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_registers';
  end if;

  v_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'protocol_version', p_protocol_version,
          'task_id', p_task_id,
          'registers', p_registers
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  select h.epoch
    into v_epoch
    from public.sync_head h
   where h.singleton
   for update;

  select a.payload_hash, a.result_seq, a.result_snapshot
    into v_existing_hash, v_existing_seq, v_existing_snapshot
    from public.applied_mutations a
   where a.mutation_id = p_operation_id;

  if found then
    if v_existing_hash <> v_hash then
      raise exception using errcode = '22023', message = 'idempotency_mismatch';
    end if;

    return query select v_epoch, v_existing_seq, v_existing_snapshot, true;
    return;
  end if;

  select * into v_task
    from public.tasks t
   where t.id = p_task_id
   for update;

  if not found then
    insert into public.tasks (id) values (p_task_id)
    returning * into v_task;
  end if;

  v_register := p_registers -> 'title';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = '22023', message = 'invalid_title_register';
    end if;
    if char_length(v_value #>> '{}') between 1 and 500 and v_stamp > v_task.title_clock then
      v_task.title := btrim(v_value #>> '{}');
      if v_task.title = '' then
        raise exception using errcode = '22023', message = 'empty_title';
      end if;
      v_task.title_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'schedule';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or jsonb_typeof(v_value) <> 'object'
       or (v_value ->> 'bucket') not in ('today', 'inbox') then
      raise exception using errcode = '22023', message = 'invalid_schedule_register';
    end if;
    if v_stamp > v_task.schedule_clock then
      v_task.bucket := v_value ->> 'bucket';
      v_task.due_date := case
        when v_value -> 'due_date' is null or v_value -> 'due_date' = 'null'::jsonb then null
        else (v_value ->> 'due_date')::date
      end;
      v_task.schedule_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'priority';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or (v_value #>> '{}') not in ('high', 'low') then
      raise exception using errcode = '22023', message = 'invalid_priority_register';
    end if;
    if v_stamp > v_task.priority_clock then
      v_task.priority := v_value #>> '{}';
      v_task.priority_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'area';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or (v_value #>> '{}') not in ('personal', 'work') then
      raise exception using errcode = '22023', message = 'invalid_area_register';
    end if;
    if v_stamp > v_task.area_clock then
      v_task.area := v_value #>> '{}';
      v_task.area_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'estimate';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or not (
      v_value = 'null'::jsonb
      or (jsonb_typeof(v_value) = 'number' and (v_value #>> '{}')::integer between 1 and 1440)
    ) then
      raise exception using errcode = '22023', message = 'invalid_estimate_register';
    end if;
    if v_stamp > v_task.estimate_clock then
      v_task.estimate_minutes := case when v_value = 'null'::jsonb then null else (v_value #>> '{}')::integer end;
      v_task.estimate_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'order';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or jsonb_typeof(v_value) <> 'string'
       or char_length(v_value #>> '{}') < 1
       or (v_value #>> '{}') !~ '^[0-9A-Za-z]+$'
       or right(v_value #>> '{}', 1) = '0' then
      raise exception using errcode = '22023', message = 'invalid_order_register';
    end if;
    if v_stamp > v_task.order_clock then
      v_task.order_key := v_value #>> '{}';
      v_task.order_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'completion';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or not (v_value = 'null'::jsonb or jsonb_typeof(v_value) = 'string') then
      raise exception using errcode = '22023', message = 'invalid_completion_register';
    end if;
    if v_stamp > v_task.completion_clock then
      v_task.completed_at := case when v_value = 'null'::jsonb then null else (v_value #>> '{}')::timestamptz end;
      v_task.completion_clock := v_stamp;
    end if;
  end if;

  v_register := p_registers -> 'deletion';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    if v_stamp is null or not (v_value = 'null'::jsonb or jsonb_typeof(v_value) = 'string') then
      raise exception using errcode = '22023', message = 'invalid_deletion_register';
    end if;
    if v_stamp > v_task.deletion_clock then
      v_task.deleted_at := case when v_value = 'null'::jsonb then null else (v_value #>> '{}')::timestamptz end;
      v_task.deletion_clock := v_stamp;
    end if;
  end if;

  if v_task.title = '' then
    raise exception using errcode = '22023', message = 'missing_title';
  end if;

  update public.tasks t
     set title = v_task.title,
         bucket = v_task.bucket,
         priority = v_task.priority,
         area = v_task.area,
         due_date = v_task.due_date,
         estimate_minutes = v_task.estimate_minutes,
         order_key = v_task.order_key,
         completed_at = v_task.completed_at,
         deleted_at = v_task.deleted_at,
         updated_at = now(),
         server_version = t.server_version + 1,
         title_clock = v_task.title_clock,
         schedule_clock = v_task.schedule_clock,
         priority_clock = v_task.priority_clock,
         area_clock = v_task.area_clock,
         estimate_clock = v_task.estimate_clock,
         order_clock = v_task.order_clock,
         completion_clock = v_task.completion_clock,
         deletion_clock = v_task.deletion_clock
   where t.id = p_task_id
  returning * into v_task;

  update public.sync_head h
     set last_seq = h.last_seq + 1
   where h.singleton
  returning h.epoch, h.last_seq into v_epoch, v_seq;

  v_existing_snapshot := to_jsonb(v_task);

  insert into public.sync_changes (
    seq, epoch, mutation_id, task_id, protocol_version, snapshot
  ) values (
    v_seq, v_epoch, p_operation_id, p_task_id, p_protocol_version, v_existing_snapshot
  );

  insert into public.applied_mutations (
    mutation_id, payload_hash, result_seq, result_snapshot
  ) values (
    p_operation_id, v_hash, v_seq, v_existing_snapshot
  );

  return query select v_epoch, v_seq, v_existing_snapshot, false;
end;
$$;

create or replace function public.pull_task_changes(
  p_epoch uuid,
  p_after_seq bigint,
  p_limit integer default 200
)
returns table (
  seq bigint,
  protocol_version integer,
  snapshot jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_epoch uuid;
begin
  select h.epoch into v_epoch from public.sync_head h where h.singleton;
  if p_epoch is distinct from v_epoch then
    raise exception using errcode = '22023', message = 'epoch_mismatch';
  end if;

  return query
    select c.seq, c.protocol_version, c.snapshot
      from public.sync_changes c
     where c.epoch = p_epoch and c.seq > greatest(p_after_seq, 0)
     order by c.seq
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

create or replace function public.bootstrap_tasks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_epoch uuid;
  v_watermark bigint;
  v_tasks jsonb;
begin
  select h.epoch, h.last_seq
    into v_epoch, v_watermark
    from public.sync_head h
   where h.singleton
   for update;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb)
    into v_tasks
    from public.tasks t;

  return jsonb_build_object(
    'protocol_version', 1,
    'epoch', v_epoch,
    'watermark', v_watermark,
    'tasks', v_tasks
  );
end;
$$;

alter table public.tasks enable row level security;
alter table public.sync_changes enable row level security;
alter table public.sync_head enable row level security;

create policy "anonymous task reads"
  on public.tasks for select to anon using (true);

create policy "anonymous change reads"
  on public.sync_changes for select to anon using (true);

create policy "anonymous head reads"
  on public.sync_head for select to anon using (true);

grant usage on schema public to anon, authenticated;
grant select on public.tasks, public.sync_changes, public.sync_head to anon, authenticated;

revoke all on function public.apply_task_mutation(uuid, uuid, integer, jsonb) from public;
revoke all on function public.pull_task_changes(uuid, bigint, integer) from public;
revoke all on function public.bootstrap_tasks() from public;

grant execute on function public.apply_task_mutation(uuid, uuid, integer, jsonb) to anon, authenticated;
grant execute on function public.pull_task_changes(uuid, bigint, integer) to anon, authenticated;
grant execute on function public.bootstrap_tasks() to anon, authenticated;

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'sync_changes'
  ) then
    alter publication supabase_realtime add table public.sync_changes;
  end if;
end;
$$;
