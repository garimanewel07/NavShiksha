-- Timetable, done properly: bell schedules with breaks, special days, teacher absence with
-- proxies, teaching loads for the generator, and proxy limits. Additive only.

-- ── Bell schedules ─────────────────────────────────────────────────────────────────────────
-- A school's timings for a group of classes, versioned by date. A new version from a date closes
-- the old one the day before; class timetables are republished on the new times automatically.
create table bell_schedule (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  name         text not null check (length(trim(name)) > 1),
  class_codes  text[] not null check (cardinality(class_codes) > 0),
  valid        daterange not null check (not isempty(valid)),
  created_by   uuid not null references app_user (id),
  created_at   timestamptz not null default now()
);
create index bell_schedule_school on bell_schedule (school_id);
create function bell_schedule_check() returns trigger language plpgsql as $$
declare clash text;
begin
  if not exists (select 1 from org_unit where id = new.school_id and kind = 'school') then
    raise exception 'bell schedules belong to a school' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.class_codes) c where c not in (select code from class_level)) then
    raise exception 'unknown class in the bell schedule' using errcode = 'check_violation';
  end if;
  select b.name into clash from bell_schedule b
   where b.school_id = new.school_id and b.id <> new.id and b.valid && new.valid and b.class_codes && new.class_codes limit 1;
  if clash is not null then
    raise exception 'these classes already follow “%” on some of these dates', clash using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.school_id <> old.school_id or new.class_codes <> old.class_codes or new.name <> old.name or lower(new.valid) <> lower(old.valid)) then
    raise exception 'a bell schedule cannot be edited; publish a new version from a date' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger bell_schedule_check before insert or update on bell_schedule for each row execute function bell_schedule_check();
-- A version can be deleted (replaced) only while it has not yet come into force.
create function bell_future_only() returns trigger language plpgsql as $$
declare starts date;
begin
  if tg_table_name = 'bell_slot' then
    select lower(valid) into starts from bell_schedule where id = old.schedule_id;
    if tg_op = 'UPDATE' then raise exception 'bell timings cannot be edited; publish a new version' using errcode = 'check_violation'; end if;
  else
    starts := lower(old.valid);
  end if;
  if starts is null or starts <= current_date then
    raise exception 'timings already in force cannot be deleted; publish a new version from a date' using errcode = 'check_violation';
  end if;
  return old;
end $$;
create trigger bell_schedule_no_delete before delete on bell_schedule for each row execute function bell_future_only();
create trigger bell_schedule_audit after insert or update on bell_schedule for each row execute function audit_row();

create table bell_slot (
  schedule_id  uuid not null references bell_schedule (id),
  weekday      smallint not null check (weekday between 1 and 6),
  seq          smallint not null check (seq between 1 and 30),
  kind         text not null check (kind in ('PERIOD', 'ASSEMBLY', 'BREAK', 'LUNCH', 'ACTIVITY')),
  label        text not null check (length(trim(label)) > 0 and length(label) <= 40),
  period_no    smallint check (period_no between 1 and 12),
  starts       time not null,
  ends         time not null,
  primary key (schedule_id, weekday, seq),
  check (ends > starts),
  check ((kind = 'PERIOD') = (period_no is not null)),
  exclude using gist (schedule_id with =, weekday with =, tsrange(timestamp '2000-01-01' + starts, timestamp '2000-01-01' + ends) with &&)
);
create unique index bell_slot_period on bell_slot (schedule_id, weekday, period_no) where period_no is not null;
create trigger bell_slot_immutable before update or delete on bell_slot for each row execute function bell_future_only();

-- ── Special days ───────────────────────────────────────────────────────────────────────────
-- An event, exam or short day changes one date for some classes: cancel chosen periods, or run
-- the day on different timings. Teachers freed by it are available for proxies.
create table day_plan (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references org_unit (id),
  on_date            date not null,
  class_codes        text[],                               -- null means every class
  kind               text not null check (kind in ('EVENT', 'EXAM', 'SHORT_DAY', 'NO_CLASSES')),
  title              text not null check (length(trim(title)) > 1 and length(title) <= 120),
  cancelled_periods  smallint[] not null default '{}',
  alt_slots          jsonb,                                -- [{period_no, starts, ends}] for a short day
  created_by         uuid not null references app_user (id),
  created_at         timestamptz not null default now(),
  withdrawn_at       timestamptz,
  check (kind <> 'SHORT_DAY' or alt_slots is not null)
);
create index day_plan_school_date on day_plan (school_id, on_date);
create function day_plan_check() returns trigger language plpgsql as $$
declare clash text;
begin
  if new.withdrawn_at is null then
    select d.title into clash from day_plan d
     where d.school_id = new.school_id and d.on_date = new.on_date and d.id <> new.id and d.withdrawn_at is null
       and (d.class_codes is null or new.class_codes is null or d.class_codes && new.class_codes) limit 1;
    if clash is not null then
      raise exception 'these classes already have “%” planned on that day', clash using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger day_plan_check before insert on day_plan for each row execute function day_plan_check();
create trigger day_plan_guard before update or delete on day_plan for each row execute function withdraw_only();
create trigger day_plan_audit after insert or update on day_plan for each row execute function audit_row();

-- ── Teacher absence and proxies ────────────────────────────────────────────────────────────
create table teacher_absence (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  teacher_id    uuid not null references app_user (id),
  period        daterange not null check (not isempty(period)),
  periods       smallint[],                                -- null means the whole day
  reason        text not null check (length(trim(reason)) > 1 and length(reason) <= 200),
  recorded_by   uuid not null references app_user (id),
  recorded_at   timestamptz not null default now(),
  withdrawn_at  timestamptz,
  exclude using gist (teacher_id with =, period with &&) where (withdrawn_at is null)
);
create trigger teacher_absence_guard before update or delete on teacher_absence for each row execute function withdraw_only();
create trigger teacher_absence_audit after insert or update on teacher_absence for each row execute function audit_row();

-- One arrangement per class per period per day. A proxy teacher can never cover two classes at
-- once, and an absent teacher can never be given a proxy.
create table substitution (
  on_date             date not null,
  section_id          uuid not null references section (id),
  period_no           smallint not null,
  starts              time not null,
  ends                time not null,
  subject_code        text references subject (code),
  absent_teacher_id   uuid references app_user (id),
  kind                text not null check (kind in ('PROXY', 'MERGE', 'STUDY')),
  substitute_id       uuid references app_user (id),
  merged_with         uuid references section (id),
  auto                boolean not null default false,
  assigned_by         uuid not null references app_user (id),
  assigned_at         timestamptz not null default now(),
  primary key (on_date, section_id, period_no),
  check ((kind = 'PROXY') = (substitute_id is not null)),
  check ((kind = 'MERGE') = (merged_with is not null)),
  check (ends > starts)
);
create index substitution_teacher on substitution (substitute_id, on_date);
create function substitution_check() returns trigger language plpgsql as $$
begin
  if new.substitute_id is not null then
    if exists (select 1 from teacher_absence a where a.teacher_id = new.substitute_id and a.withdrawn_at is null and a.period @> new.on_date
               and (a.periods is null or new.period_no = any(a.periods))) then
      raise exception 'that teacher is marked absent' using errcode = 'check_violation';
    end if;
    if exists (select 1 from substitution s where s.substitute_id = new.substitute_id and s.on_date = new.on_date
               and not (s.section_id = new.section_id and s.period_no = new.period_no) and s.starts < new.ends and new.starts < s.ends) then
      raise exception 'that teacher already has a proxy at this time' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger substitution_check before insert or update on substitution for each row execute function substitution_check();
create trigger substitution_audit after insert or update or delete on substitution for each row execute function audit_row();

-- Limits that keep proxies fair; each school sets its own.
create table timetable_setting (
  school_id         uuid primary key references org_unit (id),
  max_proxy_day     smallint not null default 2 check (max_proxy_day between 0 and 8),
  max_proxy_week    smallint not null default 6 check (max_proxy_week between 0 and 30),
  max_periods_day   smallint not null default 7 check (max_periods_day between 1 and 12)
);

-- ── Teaching load (input to the generator) ─────────────────────────────────────────────────
create table teaching_load (
  section_id        uuid not null references section (id),
  subject_code      text not null references subject (code),
  teacher_id        uuid references app_user (id),
  periods_per_week  smallint not null check (periods_per_week between 1 and 12),
  max_per_day       smallint not null default 2 check (max_per_day between 1 and 4),
  primary key (section_id, subject_code)
);
create trigger teaching_load_audit after insert or update or delete on teaching_load for each row execute function audit_row();

-- Proxy notifications use their own kind.
alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY'));
