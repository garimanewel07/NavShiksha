-- R3: academics. Assessments and marks, results frozen at publishing, grade scales as data,
-- Holistic Progress Card entries, and NES awards with maker-checker approval. Additive only.

-- Grade scales are data: a percentage takes the grade of the highest band whose minimum it reaches.
create table grade_band (
  scale    text not null check (scale ~ '^[A-Z0-9_]{2,20}$'),
  grade    text not null check (length(grade) between 1 and 4),
  min_pct  numeric(5,2) not null check (min_pct between 0 and 100),
  points   smallint not null check (points between 0 and 10),      -- weight in the Performance Index
  primary key (scale, grade),
  unique (scale, min_pct)
);
insert into grade_band (scale, grade, min_pct, points) values
  ('CBSE9', 'A1', 91, 8), ('CBSE9', 'A2', 81, 7), ('CBSE9', 'B1', 71, 6), ('CBSE9', 'B2', 61, 5),
  ('CBSE9', 'C1', 51, 4), ('CBSE9', 'C2', 41, 3), ('CBSE9', 'D', 33, 2), ('CBSE9', 'E', 0, 1);

create function grade_for(p_scale text, p_pct numeric) returns text language sql stable as $$
  select grade from grade_band where scale = p_scale and min_pct <= p_pct order by min_pct desc limit 1
$$;

-- An assessment is one exam in one school's year: PT1, Half-Yearly, Annual. Its weight is its
-- share of the final result, so the result formula changes by data, not code.
create table assessment (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  academic_year text not null references academic_year (code),
  code          text not null check (code ~ '^[A-Z0-9]{2,10}$'),
  name          text not null check (length(trim(name)) > 1),
  kind          text not null check (kind in ('PERIODIC', 'TERM', 'ANNUAL')),
  weight        numeric(5,2) not null default 0 check (weight between 0 and 100),
  scale         text not null default 'CBSE9',
  starts        date,
  ends          date,
  status        text not null default 'DRAFT' check (status in ('DRAFT', 'OPEN', 'LOCKED', 'PUBLISHED')),
  created_by    uuid not null references app_user (id),
  locked_by     uuid references app_user (id),
  locked_at     timestamptz,
  published_by  uuid references app_user (id),
  published_at  timestamptz,
  unique (school_id, academic_year, code),
  check (ends is null or starts is null or ends >= starts),
  check ((status = 'PUBLISHED') = (published_at is not null))
);
create function assessment_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from org_unit where id = new.school_id and kind = 'school') then
    raise exception 'assessments belong to a school' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from grade_band where scale = new.scale) then
    raise exception 'unknown grade scale %', new.scale using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'PUBLISHED' then
      raise exception 'a published result cannot be changed' using errcode = 'check_violation';
    end if;
    if new.status <> old.status and not (
        (old.status = 'DRAFT' and new.status = 'OPEN') or (old.status = 'OPEN' and new.status = 'LOCKED') or
        (old.status = 'LOCKED' and new.status in ('OPEN', 'PUBLISHED'))) then
      raise exception 'an assessment cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger assessment_check before insert or update on assessment for each row execute function assessment_check();
create trigger assessment_no_delete before delete on assessment for each row execute function forbid_change();
create trigger assessment_audit after insert or update on assessment for each row execute function audit_row();

-- Reopening a locked assessment needs a reason, kept for ever.
create table assessment_reopen (
  id             bigserial primary key,
  assessment_id  uuid not null references assessment (id),
  reason         text not null check (length(trim(reason)) > 4),
  reopened_by    uuid not null references app_user (id),
  reopened_at    timestamptz not null default now()
);
create trigger assessment_reopen_immutable before update or delete on assessment_reopen for each row execute function forbid_change();

-- The papers: which subjects each class sits, out of how many marks.
create table assessment_paper (
  assessment_id  uuid not null references assessment (id),
  class_code     text not null references class_level (code),
  subject_code   text not null references subject (code),
  max_marks      numeric(5,1) not null check (max_marks > 0 and max_marks <= 200),
  exam_date      date,
  primary key (assessment_id, class_code, subject_code)
);
create function paper_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from assessment where id = coalesce(new.assessment_id, old.assessment_id);
  if st not in ('DRAFT', 'OPEN') then
    raise exception 'papers cannot change once marks are locked' using errcode = 'check_violation';
  end if;
  if tg_op <> 'INSERT' and exists (select 1 from mark where assessment_id = old.assessment_id and subject_code = old.subject_code) then
    if tg_op = 'DELETE' or new.max_marks <> old.max_marks then
      raise exception 'marks have been entered for this paper; it cannot be removed or rescaled' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger paper_guard before insert or update or delete on assessment_paper for each row execute function paper_guard();
create trigger paper_audit after insert or update or delete on assessment_paper for each row execute function audit_row();

-- Marks: only while the assessment is open, never above the paper's maximum, only for a paper the
-- child's class actually sits.
create table mark (
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  subject_code   text not null references subject (code),
  marks          numeric(5,1),
  absent         boolean not null default false,
  entered_by     uuid not null references app_user (id),
  entered_at     timestamptz not null default now(),
  primary key (assessment_id, enrolment_id, subject_code),
  check ((absent and marks is null) or (not absent and marks is not null and marks >= 0))
);
create function mark_guard() returns trigger language plpgsql as $$
declare st text; mx numeric; cls text;
begin
  select status into st from assessment where id = coalesce(new.assessment_id, old.assessment_id);
  if st <> 'OPEN' then
    raise exception 'marks for this assessment are %', lower(st) using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select class_code into cls from enrolment where id = new.enrolment_id;
  select max_marks into mx from assessment_paper where assessment_id = new.assessment_id and class_code = cls and subject_code = new.subject_code;
  if mx is null then
    raise exception 'class % does not sit % in this assessment', cls, new.subject_code using errcode = 'check_violation';
  end if;
  if new.marks > mx then
    raise exception 'marks % are above the maximum of %', new.marks, mx using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger mark_guard before insert or update or delete on mark for each row execute function mark_guard();
create trigger mark_audit after insert or update or delete on mark for each row execute function audit_row();

-- Results are computed once, when the principal publishes, and never change afterwards.
create table result (
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  section_id     uuid references section (id),
  class_code     text not null,
  obtained       numeric(7,1) not null,
  max_total      numeric(7,1) not null check (max_total > 0),
  percentage     numeric(5,2) not null check (percentage between 0 and 100),
  grade          text not null,
  rank_section   int,
  rank_class     int not null,
  subjects       jsonb not null,          -- [{code, name, marks, max, pct, grade, absent}]
  primary key (assessment_id, enrolment_id)
);
create trigger result_immutable before update or delete on result for each row execute function forbid_change();

-- Holistic Progress Card (NEP 2020): competency domains by stage, a level and a remark per child.
create table hpc_domain (
  code     text primary key check (code ~ '^[A-Z_]{3,20}$'),
  name     text not null,
  hint     text not null,
  ordinal  smallint not null
);
insert into hpc_domain (code, name, hint, ordinal) values
  ('PHYSICAL', 'Physical development', 'Fitness, motor skills, sport and healthy habits', 1),
  ('SOCIO_EMOTIONAL', 'Socio-emotional', 'Self-awareness, empathy, working with others', 2),
  ('COGNITIVE', 'Cognitive', 'Reasoning, problem-solving, curiosity', 3),
  ('LANGUAGE', 'Language and literacy', 'Listening, speaking, reading and writing', 4),
  ('AESTHETIC', 'Aesthetic and cultural', 'Art, music, dance, drama', 5),
  ('HABITS', 'Positive learning habits', 'Punctuality, attention, care for materials', 6);

create table hpc_entry (
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  domain_code    text not null references hpc_domain (code),
  level          text not null check (level in ('BEGINNER', 'PROGRESSING', 'PROFICIENT', 'ADVANCED')),
  remark         text not null default '' check (length(remark) <= 500),
  entered_by     uuid not null references app_user (id),
  entered_at     timestamptz not null default now(),
  primary key (assessment_id, enrolment_id, domain_code)
);
create table report_remark (
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  remark         text not null check (length(trim(remark)) > 0 and length(remark) <= 800),
  entered_by     uuid not null references app_user (id),
  entered_at     timestamptz not null default now(),
  primary key (assessment_id, enrolment_id)
);
create function report_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from assessment where id = coalesce(new.assessment_id, old.assessment_id);
  if st <> 'OPEN' then
    raise exception 'report entries for this assessment are %', lower(st) using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger hpc_guard before insert or update or delete on hpc_entry for each row execute function report_guard();
create trigger remark_guard before insert or update or delete on report_remark for each row execute function report_guard();
create trigger hpc_audit after insert or update or delete on hpc_entry for each row execute function audit_row();
create trigger remark_audit after insert or update or delete on report_remark for each row execute function audit_row();

-- ── Awards ────────────────────────────────────────────────────────────────────────────────
insert into ledger_account (code, name, type) values
  ('1100', 'Bank account', 'ASSET'),
  ('5200', 'Awards and prizes', 'EXPENSE');

-- NES defines the awards (cash prizes for toppers, Outstanding Teacher Award). Amounts are data.
create table award_scheme (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9_]{3,30}$'),
  name          text not null,
  kind          text not null check (kind in ('STUDENT', 'TEACHER')),
  amount_paise  bigint not null check (amount_paise >= 0),
  criteria      text not null default '',
  valid         daterange not null,
  created_by    uuid not null references app_user (id)
);
create trigger award_scheme_audit after insert or update on award_scheme for each row execute function audit_row();

-- A school nominates; a different NES officer approves; NES pays. Each step is permanent.
create table award_nomination (
  id             uuid primary key default gen_random_uuid(),
  scheme_id      uuid not null references award_scheme (id),
  school_id      uuid not null references org_unit (id),
  academic_year  text not null references academic_year (code),
  student_id     uuid references student (id),
  teacher_id     uuid references app_user (id),
  citation       text not null check (length(trim(citation)) > 9 and length(citation) <= 1500),
  evidence       jsonb not null default '{}',
  nominated_by   uuid not null references app_user (id),
  nominated_at   timestamptz not null default now(),
  status         text not null default 'NOMINATED' check (status in ('NOMINATED', 'APPROVED', 'REJECTED', 'PAID')),
  decided_by     uuid references app_user (id),
  decided_at     timestamptz,
  decision_note  text,
  paid_at        timestamptz,
  payment_ref    text,
  check ((student_id is null) <> (teacher_id is null)),
  check (decided_by is null or decided_by <> nominated_by),
  check ((status in ('APPROVED', 'REJECTED', 'PAID')) = (decided_by is not null)),
  check ((status = 'PAID') = (paid_at is not null and payment_ref is not null))
);
create unique index award_once_student on award_nomination (scheme_id, academic_year, student_id) where student_id is not null and status <> 'REJECTED';
create unique index award_once_teacher on award_nomination (scheme_id, academic_year, teacher_id) where teacher_id is not null and status <> 'REJECTED';
create function award_check() returns trigger language plpgsql as $$
declare k text;
begin
  select kind into k from award_scheme where id = new.scheme_id;
  if (k = 'STUDENT') <> (new.student_id is not null) then
    raise exception 'this award is for a %', lower(k) using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.scheme_id <> old.scheme_id or new.student_id is distinct from old.student_id or new.teacher_id is distinct from old.teacher_id
       or new.citation <> old.citation or new.school_id <> old.school_id then
      raise exception 'a nomination cannot be edited; reject it and nominate again' using errcode = 'check_violation';
    end if;
    if new.status <> old.status and not (
        (old.status = 'NOMINATED' and new.status in ('APPROVED', 'REJECTED')) or (old.status = 'APPROVED' and new.status = 'PAID')) then
      raise exception 'an award cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger award_check before insert or update on award_nomination for each row execute function award_check();
create trigger award_no_delete before delete on award_nomination for each row execute function forbid_change();
create trigger award_audit after insert or update on award_nomination for each row execute function audit_row();

-- Results and awards also reach people as notifications.
alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD'));
