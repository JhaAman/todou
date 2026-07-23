begin;

alter table public.tasks drop constraint tasks_bucket_check;
alter table public.tasks
  add constraint tasks_bucket_check
  check (bucket in ('in_progress', 'today', 'inbox'));

create or replace function public.in_progress_fallback_stamp(p_stamp text)
returns text
language plpgsql
immutable
as $$
declare
  v_wall bigint;
  v_counter bigint;
begin
  if p_stamp !~ '^[0-9]{13}-[0-9]{10}-[0-9a-f]{32}$' then
    raise exception using errcode = '22023', message = 'invalid_schedule_register';
  end if;

  v_wall := split_part(p_stamp, '-', 1)::bigint;
  v_counter := split_part(p_stamp, '-', 2)::bigint;
  if v_counter = 9999999999 then
    if v_wall = 9999999999999 then
      raise exception using errcode = '22023', message = 'invalid_schedule_register';
    end if;
    v_wall := v_wall + 1;
    v_counter := 0;
  else
    v_counter := v_counter + 1;
  end if;

  return lpad(v_wall::text, 13, '0')
    || '-' || lpad(v_counter::text, 10, '0')
    || '-00000000000000000000000000000000';
end;
$$;

revoke all on function public.in_progress_fallback_stamp(text) from public;

do $migration$
declare
  definition text;
  old_values constant text := '''today'', ''inbox''';
  new_values constant text := '''in_progress'', ''today'', ''inbox''';
  old_protocol_check constant text := 'if p_protocol_version <> 1 then';
  new_protocol_check constant text := 'if p_protocol_version not in (1, 2) then';
  old_title_guard constant text := $guard$
  if v_task.title = '' then
    raise exception using errcode = '22023', message = 'missing_title';
  end if;
$guard$;
  new_title_guard constant text := $guard$
  if p_protocol_version = 1 and v_task.bucket = 'in_progress' then
    raise exception using errcode = '22023', message = 'legacy_in_progress_protocol';
  end if;

  if v_task.title = '' then
    raise exception using errcode = '22023', message = 'missing_title';
  end if;

  if v_task.bucket = 'in_progress'
     and v_task.completed_at is null
     and v_task.deleted_at is null
     and not exists (
       select 1
         from public.tasks current_task
        where current_task.id = p_task_id
          and current_task.bucket = 'in_progress'
          and current_task.completed_at is null
          and current_task.deleted_at is null
     )
     and exists (
       select 1
         from public.tasks active_in_progress
        where active_in_progress.bucket = 'in_progress'
          and active_in_progress.completed_at is null
          and active_in_progress.deleted_at is null
          and active_in_progress.id <> p_task_id
       offset 2
     )
  then
    v_task.bucket := coalesce((
      select case
        when current_task.bucket = 'in_progress' then 'inbox'
        else current_task.bucket
      end
      from public.tasks current_task
      where current_task.id = p_task_id
    ), 'inbox');
    v_task.due_date := (
      select case
        when current_task.bucket = 'in_progress' then null
        else current_task.due_date
      end
      from public.tasks current_task
      where current_task.id = p_task_id
    );
    v_task.order_key := coalesce((
      select current_task.order_key
      from public.tasks current_task
      where current_task.id = p_task_id
    ), 'V');
    v_task.schedule_clock := public.in_progress_fallback_stamp(
      greatest(v_task.schedule_clock, v_task.order_clock)
    );
    v_task.order_clock := v_task.schedule_clock;
  end if;
$guard$;
begin
  select pg_get_functiondef(
    'public.apply_task_mutation(uuid, uuid, integer, jsonb)'::regprocedure
  ) into definition;

  if position(old_values in definition) = 0 then
    raise exception 'apply_task_mutation no longer contains the expected bucket validation';
  end if;
  if position(old_protocol_check in definition) = 0 then
    raise exception 'apply_task_mutation no longer contains the expected protocol validation';
  end if;
  if position(old_title_guard in definition) = 0 then
    raise exception 'apply_task_mutation no longer contains the expected final validation';
  end if;

  definition := replace(definition, old_values, new_values);
  definition := replace(definition, old_protocol_check, new_protocol_check);
  execute replace(definition, old_title_guard, new_title_guard);
end;
$migration$;

do $migration$
declare
  definition text;
  old_version constant text := '''protocol_version'', 1';
  new_version constant text := '''protocol_version'', 2';
begin
  select pg_get_functiondef('public.bootstrap_tasks()'::regprocedure) into definition;

  if position(old_version in definition) = 0 then
    raise exception 'bootstrap_tasks no longer contains the expected protocol version';
  end if;

  execute replace(definition, old_version, new_version);
end;
$migration$;

commit;
