-- Two-way messaging with sender identity, and daily student attendance.

create table thread (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  subject       text not null check (length(trim(subject)) > 0),
  created_by    uuid not null references app_user (id),
  section_id    uuid references section (id),            -- audience: a section, or individual students
  reply_mode    text not null check (reply_mode in ('NONE', 'ALLOWED', 'REQUIRED')),
  options       text[] not null default '{}',
  created_at    timestamptz not null default now(),
  check (reply_mode <> 'REQUIRED' or cardinality(options) between 2 and 6 or cardinality(options) = 0)
);

-- Every recipient is a (student, guardian) pair, so a reply always knows which child it is about.
create table thread_recipient (
  thread_id    uuid not null references thread (id),
  student_id   uuid not null references student (id),
  guardian_id  uuid not null references guardian (id),
  primary key (thread_id, student_id, guardian_id),
  foreign key (student_id, guardian_id) references student_guardian (student_id, guardian_id)
);

create table message (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references thread (id),
  author_id      uuid not null references app_user (id),
  student_id     uuid references student (id),            -- the child a parent's reply is about
  body           text not null default '',
  choice         text,
  created_at     timestamptz not null default now(),
  check (length(trim(body)) > 0 or choice is not null)
);
create index message_thread on message (thread_id, created_at);
create trigger message_immutable before update or delete on message for each row execute function forbid_change();

create table message_read (
  message_id  uuid not null references message (id),
  user_id     uuid not null references app_user (id),
  read_at     timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table attendance_session (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references section (id),
  on_date     date not null,
  marked_by   uuid not null references app_user (id),
  marked_at   timestamptz not null default now(),
  unique (section_id, on_date)
);

create table attendance_mark (
  session_id    uuid not null references attendance_session (id),
  enrolment_id  uuid not null references enrolment (id),
  status        text not null check (status in ('P', 'A', 'L')),
  primary key (session_id, enrolment_id)
);

-- Attendance can be corrected on the day it was taken. After that it is locked (no backdating).
create function attendance_lock() returns trigger language plpgsql as $$
declare d date;
begin
  select on_date into d from attendance_session where id = coalesce(new.session_id, old.session_id);
  if d < current_date then
    raise exception 'attendance for % is locked' , d using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger attendance_lock before update or delete on attendance_mark for each row execute function attendance_lock();
create trigger attendance_audit after insert or update or delete on attendance_mark for each row execute function audit_row();
