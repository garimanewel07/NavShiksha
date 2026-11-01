-- R2: daily school life. Class teachers, houses, subjects, timetables, homework, calendar,
-- student leave, notices and the notification centre. Additive only.

-- A record that may only be withdrawn: every column is fixed except withdrawn_at, which can be
-- set once. Corrections are a new record, so what parents saw is never silently rewritten.
create function withdraw_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% records cannot be deleted; withdraw them instead', tg_table_name using errcode = 'check_violation';
  end if;
  if old.withdrawn_at is not null then
    raise exception 'this % has already been withdrawn', tg_table_name using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - 'withdrawn_at') <> (to_jsonb(old) - 'withdrawn_at') then
    raise exception 'a published % cannot be edited; withdraw it and publish a new one', tg_table_name using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Only the columns named in the trigger arguments may change.
create function only_changes() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% records cannot be deleted', tg_table_name using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - tg_argv) <> (to_jsonb(old) - tg_argv) then
    raise exception 'only % can change on %', array_to_string(tg_argv, ', '), tg_table_name using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Class teachers -----------------------------------------------------------------------------
alter table section add column class_teacher_id uuid references app_user (id);

-- Houses -------------------------------------------------------------------------------------
create table house (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references org_unit (id),
  name       text not null check (length(trim(name)) > 1),
  colour     text not null check (colour ~ '^#[0-9A-Fa-f]{6}$'),
  unique (school_id, name)
);
alter table enrolment add column house_id uuid references house (id);
create function enrolment_check_house() returns trigger language plpgsql as $$
begin
  if new.house_id is not null and not exists (select 1 from house where id = new.house_id and school_id = new.school_id) then
    raise exception 'the house belongs to a different school' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger enrolment_check_house before insert or update of house_id, school_id on enrolment for each row execute function enrolment_check_house();

alter table student add column blood_group text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));

-- Subjects and timetables ----------------------------------------------------------------------
create table subject (
  code  text primary key check (code ~ '^[A-Z]{2,4}$'),
  name  text not null unique
);
insert into subject (code, name) values
  ('ENG', 'English'), ('HIN', 'Hindi'), ('SAN', 'Sanskrit'), ('MAT', 'Mathematics'), ('SCI', 'Science'), ('SST', 'Social Science'),
  ('EVS', 'Environmental Studies'), ('CS', 'Computer Science'), ('PHY', 'Physics'), ('CHE', 'Chemistry'), ('BIO', 'Biology'),
  ('ACC', 'Accountancy'), ('BST', 'Business Studies'), ('ECO', 'Economics'), ('HIS', 'History'), ('GEO', 'Geography'),
  ('POL', 'Political Science'), ('PSY', 'Psychology'), ('PE', 'Physical Education'), ('ART', 'Art'), ('MUS', 'Music'), ('LIB', 'Library');

-- A section's timetable is versioned by date: a new timetable from a date closes the old one, and
-- two timetables for one section can never cover the same day.
create table timetable (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references section (id),
  valid       daterange not null check (not isempty(valid)),
  created_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now(),
  exclude using gist (section_id with =, valid with &&)
);
create trigger timetable_audit after insert or update or delete on timetable for each row execute function audit_row();

create table timetable_slot (
  timetable_id  uuid not null references timetable (id) on delete cascade,
  weekday       smallint not null check (weekday between 1 and 6),
  period        smallint not null check (period between 1 and 10),
  starts        time not null,
  ends          time not null,
  subject_code  text not null references subject (code),
  teacher_id    uuid references app_user (id),
  room          text,
  primary key (timetable_id, weekday, period),
  check (ends > starts)
);
create trigger timetable_slot_audit after insert or update or delete on timetable_slot for each row execute function audit_row();

-- A teacher cannot be in two classrooms at once on any day both timetables are in force.
create function timetable_teacher_clash() returns trigger language plpgsql as $$
declare clash text;
begin
  if new.teacher_id is null then return new; end if;
  select sec.class_code || '-' || sec.name into clash
    from timetable_slot o
    join timetable t on t.id = o.timetable_id
    join timetable mine on mine.id = new.timetable_id
    join section sec on sec.id = t.section_id
   where o.teacher_id = new.teacher_id and o.weekday = new.weekday
     and not (o.timetable_id = new.timetable_id and o.period = new.period)
     and o.starts < new.ends and new.starts < o.ends
     and t.valid && mine.valid
   limit 1;
  if clash is not null then
    raise exception 'this teacher already has class % at that time', clash using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger timetable_teacher_clash before insert or update on timetable_slot for each row execute function timetable_teacher_clash();

-- Homework -------------------------------------------------------------------------------------
create table homework (
  id            uuid primary key default gen_random_uuid(),
  section_id    uuid not null references section (id),
  subject_code  text not null references subject (code),
  title         text not null check (length(trim(title)) > 2),
  details       text not null default '' check (length(details) <= 4000),
  assigned_on   date not null default current_date,
  due_on        date not null,
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,
  check (due_on >= assigned_on)
);
create index homework_section on homework (section_id, due_on desc);
create trigger homework_guard before update or delete on homework for each row execute function withdraw_only();
create trigger homework_audit after insert or update on homework for each row execute function audit_row();

-- A parent ticks homework as done for one child; un-ticking deletes the row.
create table homework_done (
  homework_id  uuid not null references homework (id),
  student_id   uuid not null references student (id),
  done_at      timestamptz not null default now(),
  done_by      uuid not null references app_user (id),
  primary key (homework_id, student_id)
);

-- Academic calendar ----------------------------------------------------------------------------
-- An event belongs to any unit: NES-wide holidays, Command events or one school's PTM.
create table calendar_event (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references org_unit (id),
  title       text not null check (length(trim(title)) > 1),
  kind        text not null check (kind in ('HOLIDAY', 'VACATION', 'EXAM', 'EVENT', 'PTM')),
  period      daterange not null check (not isempty(period)),
  details     text not null default '',
  created_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now()
);
create index calendar_event_unit on calendar_event (unit_id, lower(period));
create trigger calendar_event_audit after insert or update or delete on calendar_event for each row execute function audit_row();

-- Student leave --------------------------------------------------------------------------------
create table leave_request (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references student (id),
  enrolment_id   uuid not null references enrolment (id),
  period         daterange not null check (not isempty(period)),
  reason         text not null check (length(trim(reason)) > 2 and length(reason) <= 1000),
  applied_by     uuid not null references app_user (id),
  applied_at     timestamptz not null default now(),
  status         text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by     uuid references app_user (id),
  decided_at     timestamptz,
  decision_note  text,
  check ((status in ('APPROVED', 'REJECTED')) = (decided_by is not null)),
  exclude using gist (student_id with =, period with &&) where (status in ('PENDING', 'APPROVED'))
);
create function leave_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'leave requests cannot be deleted' using errcode = 'check_violation'; end if;
  if new.student_id <> old.student_id or new.enrolment_id <> old.enrolment_id or new.period <> old.period or new.reason <> old.reason then
    raise exception 'a leave request cannot be edited; cancel it and apply again' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED', 'CANCELLED')) or
       (old.status = 'APPROVED' and new.status = 'CANCELLED')) then
    raise exception 'leave cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger leave_transition before update or delete on leave_request for each row execute function leave_transition();
create trigger leave_audit after insert or update on leave_request for each row execute function audit_row();

-- Notices and circulars --------------------------------------------------------------------------
-- Issued by NES, a Command or a school; reaches every school under that unit. Never edited after
-- publishing — withdrawn and reissued instead.
create table notice (
  id            uuid primary key default gen_random_uuid(),
  unit_id       uuid not null references org_unit (id),
  title         text not null check (length(trim(title)) > 2 and length(title) <= 160),
  body          text not null check (length(trim(body)) > 0 and length(body) <= 8000),
  kind          text not null check (kind in ('CIRCULAR', 'NOTICE', 'EVENT', 'URGENT')),
  audience      text not null check (audience in ('ALL', 'PARENTS', 'STAFF')),
  class_codes   text[],
  is_public     boolean not null default false,       -- also shown on the school website
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz
);
create index notice_unit on notice (unit_id, created_at desc);
create trigger notice_guard before update or delete on notice for each row execute function withdraw_only();
create trigger notice_audit after insert or update on notice for each row execute function audit_row();

-- Notification centre ----------------------------------------------------------------------------
-- One row per person per event, written in the same transaction as the event. Only read_at changes.
create table notification (
  id          bigserial primary key,
  user_id     uuid not null references app_user (id),
  student_id  uuid references student (id),
  kind        text not null check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT')),
  title       text not null,
  body        text not null default '',
  link        text,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index notification_user on notification (user_id, created_at desc);
create index notification_unread on notification (user_id) where read_at is null;
create trigger notification_guard before update or delete on notification for each row execute function only_changes('read_at');
