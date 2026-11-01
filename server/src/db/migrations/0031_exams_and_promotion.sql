-- Exams, the rest: rooms; seating plans and invigilation duties; moderation of marks sheets;
-- answer-script bundles; CBSE registration and board results; Class XI streams; and promotion to
-- the next academic year, with each child's class kept year by year.

-- ── Rooms ──────────────────────────────────────────────────────────────────────────────────
create table room (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  campus_id      uuid not null references org_unit (id),
  name           text not null,
  kind           text not null default 'CLASSROOM' check (kind in ('CLASSROOM', 'LAB', 'HALL', 'LIBRARY', 'OTHER')),
  capacity       smallint not null check (capacity between 1 and 1000),
  exam_seats     smallint not null check (exam_seats between 0 and 1000),
  active         boolean not null default true,
  unique (campus_id, name)
);
create trigger room_audit after insert or update on room for each row execute function audit_row();

-- ── Seating and invigilation ──────────────────────────────────────────────────────────────
alter table assessment_paper add column session text not null default 'MORNING' check (session in ('MORNING', 'AFTERNOON'));
create table exam_seat (
  assessment_id  uuid not null references assessment (id),
  exam_date      date not null,
  session        text not null check (session in ('MORNING', 'AFTERNOON')),
  room_id        uuid not null references room (id),
  seat_no        smallint not null,
  enrolment_id   uuid not null references enrolment (id),
  subject_code   text not null references subject (code),
  primary key (assessment_id, exam_date, session, enrolment_id),
  unique (assessment_id, exam_date, session, room_id, seat_no)
);
create table invigilation (
  assessment_id  uuid not null references assessment (id),
  exam_date      date not null,
  session        text not null check (session in ('MORNING', 'AFTERNOON')),
  room_id        uuid not null references room (id),
  user_id        uuid not null references app_user (id),
  primary key (assessment_id, exam_date, session, room_id, user_id),
  unique (exam_date, session, user_id)                -- nobody is in two rooms at once
);

-- ── Moderation of marks ───────────────────────────────────────────────────────────────────
-- Each class's marks sheet for a subject: the teacher submits it, the exam in-charge (or the
-- head of department) moderates it, and every change made in moderation is kept with its reason.
create table marks_sheet (
  assessment_id   uuid not null references assessment (id),
  section_id      uuid not null references section (id),
  subject_code    text not null references subject (code),
  status          text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'MODERATED', 'RETURNED')),
  submitted_by    uuid not null references app_user (id),
  submitted_at    timestamptz not null default now(),
  moderated_by    uuid references app_user (id),
  moderated_at    timestamptz,
  note            text,
  primary key (assessment_id, section_id, subject_code)
);
create trigger marks_sheet_audit after insert or update on marks_sheet for each row execute function audit_row();
create table mark_moderation (
  id             bigserial primary key,
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  subject_code   text not null references subject (code),
  from_marks     numeric(5,1),
  to_marks       numeric(5,1),
  reason         text not null check (length(trim(reason)) > 3),
  by_user        uuid not null references app_user (id),
  at             timestamptz not null default now()
);
create trigger mark_moderation_immutable before update or delete on mark_moderation for each row execute function forbid_change();

-- ── Answer scripts ────────────────────────────────────────────────────────────────────────
create table script_bundle (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references assessment (id),
  section_id     uuid not null references section (id),
  subject_code   text not null references subject (code),
  scripts        smallint not null check (scripts between 1 and 200),
  evaluator      uuid not null references app_user (id),
  issued_by      uuid not null references app_user (id),
  issued_at      timestamptz not null default now(),
  returned_at    timestamptz,
  returned_count smallint,
  note           text,
  unique (assessment_id, section_id, subject_code)
);

-- ── The board (CBSE) ──────────────────────────────────────────────────────────────────────
create table cbse_subject (
  subject_code  text not null references subject (code),
  level         text not null check (level in ('SECONDARY', 'SENIOR')),
  cbse_code     text not null check (cbse_code ~ '^\d{3}$'),
  cbse_name     text not null,
  primary key (subject_code, level)
);
insert into cbse_subject (subject_code, level, cbse_code, cbse_name)
select x.s, x.l, x.c, x.n from (values
  ('ENG', 'SECONDARY', '184', 'English Language and Literature'), ('HIN', 'SECONDARY', '085', 'Hindi Course B'), ('SAN', 'SECONDARY', '122', 'Sanskrit'),
  ('MAT', 'SECONDARY', '041', 'Mathematics Standard'), ('SCI', 'SECONDARY', '086', 'Science'), ('SST', 'SECONDARY', '087', 'Social Science'),
  ('CS', 'SECONDARY', '402', 'Information Technology'), ('ENG', 'SENIOR', '301', 'English Core'), ('MAT', 'SENIOR', '041', 'Mathematics'),
  ('CS', 'SENIOR', '083', 'Computer Science'), ('PE', 'SENIOR', '048', 'Physical Education'), ('HIN', 'SENIOR', '302', 'Hindi Core')) as x(s, l, c, n)
where exists (select 1 from subject where code = x.s);

alter table enrolment add column board_roll_no text, add column board_reg_no text;
-- Mother's and father's names come from the guardian records (entered once, at admission).
alter table student add column social_category text check (social_category is null or social_category in ('GEN', 'OBC', 'SC', 'ST', 'EWS'));

-- Board results as published by CBSE, loaded from the result file; matched to the child's record.
create table board_result (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  year           smallint not null,
  class_code     text not null check (class_code in ('X', 'XII')),
  roll_no        text not null,
  name           text not null,
  enrolment_id   uuid references enrolment (id),
  subjects       jsonb not null,          -- [{code, name, marks, grade}]
  best5          numeric(5,1),
  percentage     numeric(5,2),
  result         text not null,           -- PASS, COMP, ESSENTIAL REPEAT, ABSENT
  imported_by    uuid not null references app_user (id),
  imported_at    timestamptz not null default now(),
  unique (school_id, year, class_code, roll_no)
);

-- ── Class XI streams ──────────────────────────────────────────────────────────────────────
alter table section add column stream text check (stream is null or stream in ('SCIENCE_PCM', 'SCIENCE_PCB', 'COMMERCE', 'HUMANITIES'));
create table stream_choice (
  enrolment_id   uuid not null references enrolment (id),
  for_year       text not null references academic_year (code),
  choices        text[] not null check (cardinality(choices) between 1 and 4),
  by_user        uuid not null references app_user (id),
  at             timestamptz not null default now(),
  allotted       text,
  primary key (enrolment_id, for_year)
);

-- ── Promotion to the next year ────────────────────────────────────────────────────────────
-- What class and section each child was in, year by year (the enrolment itself moves on).
create table class_history (
  enrolment_id   uuid not null references enrolment (id),
  academic_year  text not null references academic_year (code),
  class_code     text not null references class_level (code),
  section_id     uuid references section (id),
  roll_no        int,
  outcome        text not null check (outcome in ('PROMOTED', 'DETAINED', 'COMPLETED', 'LEFT')),
  percentage     numeric(5,2),
  decided_by     uuid not null references app_user (id),
  decided_at     timestamptz not null default now(),
  primary key (enrolment_id, academic_year)
);
create trigger class_history_immutable before update or delete on class_history for each row execute function forbid_change();

create table promotion_run (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  from_year     text not null references academic_year (code),
  to_year       text not null references academic_year (code),
  status        text not null default 'DRAFT' check (status in ('DRAFT', 'APPLIED')),
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  applied_by    uuid references app_user (id),
  applied_at    timestamptz,
  unique (school_id, from_year)
);
create table promotion_line (
  run_id         uuid not null references promotion_run (id),
  enrolment_id   uuid not null references enrolment (id),
  from_class     text not null,
  from_section   uuid references section (id),
  percentage     numeric(5,2),
  decision       text not null check (decision in ('PROMOTE', 'DETAIN', 'COMPLETE', 'LEAVE')),
  to_class       text,
  to_section     uuid references section (id),
  reason         text,
  primary key (run_id, enrolment_id)
);
