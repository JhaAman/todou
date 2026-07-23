alter table public.tasks
  add column description text not null default '',
  add column description_clock text not null default '0000000000000-0000000000-00000000000000000000000000000000',
  add constraint tasks_description_length check (char_length(description) <= 10000);

update public.sync_changes
   set snapshot = jsonb_set(
     jsonb_set(
       snapshot,
       '{description}',
       case when jsonb_typeof(snapshot -> 'description') = 'string'
         then snapshot -> 'description'
         else '""'::jsonb
       end,
       true
     ),
     '{description_clock}',
     case when jsonb_typeof(snapshot -> 'description_clock') = 'string'
       then snapshot -> 'description_clock'
       else to_jsonb('0000000000000-0000000000-00000000000000000000000000000000'::text)
     end,
     true
   )
 where jsonb_typeof(snapshot -> 'description') is distinct from 'string'
    or jsonb_typeof(snapshot -> 'description_clock') is distinct from 'string';

update public.applied_mutations
   set result_snapshot = jsonb_set(
     jsonb_set(
       result_snapshot,
       '{description}',
       case when jsonb_typeof(result_snapshot -> 'description') = 'string'
         then result_snapshot -> 'description'
         else '""'::jsonb
       end,
       true
     ),
     '{description_clock}',
     case when jsonb_typeof(result_snapshot -> 'description_clock') = 'string'
       then result_snapshot -> 'description_clock'
       else to_jsonb('0000000000000-0000000000-00000000000000000000000000000000'::text)
     end,
     true
   )
 where jsonb_typeof(result_snapshot -> 'description') is distinct from 'string'
    or jsonb_typeof(result_snapshot -> 'description_clock') is distinct from 'string';

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
  v_description text;
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

  v_register := p_registers -> 'description';
  if v_register is not null then
    v_stamp := v_register ->> 'stamp';
    v_value := v_register -> 'value';
    v_description := v_value #>> '{}';
    if v_stamp is null or jsonb_typeof(v_value) <> 'string'
       or char_length(v_description) > 10000
       or v_description <> btrim(
         v_description,
         chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(133)
           || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195)
           || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
           || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288)
       ) then
      raise exception using errcode = '22023', message = 'invalid_description_register';
    end if;
    if v_stamp > v_task.description_clock then
      v_task.description := v_description;
      v_task.description_clock := v_stamp;
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
         description = v_task.description,
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
         description_clock = v_task.description_clock,
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
    'description_register', true,
    'epoch', v_epoch,
    'watermark', v_watermark,
    'tasks', v_tasks
  );
end;
$$;
