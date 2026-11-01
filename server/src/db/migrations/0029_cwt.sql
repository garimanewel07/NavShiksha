-- The Common Written Test. Schools whose vacancies need a written test send their requirement to
-- NES; NES asks three or four other schools that already have teachers in that post for a question
-- paper and answer key, chooses the best, and the day before the test sends each centre its papers
-- in a password-protected file (the password goes separately, by SMS to the principal).

create table cwt_cycle (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^CWT-[0-9]{4}-[0-9]{1,2}$'),
  title               text not null,
  exam_date           date not null,
  starts_at           time not null default '10:00',
  duration_min        smallint not null default 150 check (duration_min between 30 and 300),
  requirements_by     date not null,                 -- schools send requirements until
  papers_due          date not null,                 -- setter schools upload by
  release_at          timestamptz not null,          -- papers to centres (normally the day before)
  status              text not null default 'OPEN' check (status in ('OPEN', 'PAPERS', 'RELEASED', 'HELD', 'RESULTS', 'CANCELLED')),
  released_at         timestamptz,
  keys_released_at    timestamptz,
  created_by          uuid not null references app_user (id),
  created_at          timestamptz not null default now(),
  check (requirements_by <= papers_due and papers_due < exam_date)
);
create trigger cwt_cycle_audit after insert or update on cwt_cycle for each row execute function audit_row();

-- One paper for each post and subject in the cycle, whichever schools need it.
create table cwt_paper (
  id             uuid primary key default gen_random_uuid(),
  cycle_id       uuid not null references cwt_cycle (id),
  code           text not null,                      -- PGT-MAT, PRT, BALVATIKA
  post_type      text not null references post_type (code),
  subject_code   text references subject (code),
  max_marks      smallint not null default 100 check (max_marks between 10 and 500),
  selected_request_id uuid,
  unique (cycle_id, code)
);

create table cwt_requirement (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid not null references cwt_cycle (id),
  paper_id      uuid not null references cwt_paper (id),
  vacancy_id    uuid not null unique references vacancy (id),
  school_id     uuid not null references org_unit (id),
  status        text not null default 'SENT' check (status in ('SENT', 'WITHDRAWN')),
  sent_by       uuid not null references app_user (id),
  sent_at       timestamptz not null default now()
);
create index cwt_requirement_cycle on cwt_requirement (cycle_id, school_id);

-- A request to a setter school; its files are encrypted at rest and only the NES CWT cell opens them.
create table cwt_paper_request (
  id              uuid primary key default gen_random_uuid(),
  paper_id        uuid not null references cwt_paper (id),
  school_id       uuid not null references org_unit (id),
  status          text not null default 'REQUESTED' check (status in ('REQUESTED', 'SUBMITTED', 'DECLINED', 'SELECTED', 'NOT_SELECTED', 'CANCELLED')),
  due_on          date not null,
  requested_by    uuid not null references app_user (id),
  requested_at    timestamptz not null default now(),
  question_name   text, question_type text, question_sha text, question_sealed bytea,
  key_name        text, key_type text, key_sha text, key_sealed bytea,
  setter_note     text,
  submitted_by    uuid references app_user (id),
  submitted_at    timestamptz,
  review_score    smallint check (review_score between 1 and 5),
  review_note     text,
  unique (paper_id, school_id),
  check (status not in ('SUBMITTED', 'SELECTED', 'NOT_SELECTED') or (question_sealed is not null and key_sealed is not null))
);
alter table cwt_paper add constraint cwt_paper_selected_fk foreign key (selected_request_id) references cwt_paper_request (id);

-- Each school that needs papers is a centre for its own candidates.
create table cwt_centre (
  id                 uuid primary key default gen_random_uuid(),
  cycle_id           uuid not null references cwt_cycle (id),
  school_id          uuid not null references org_unit (id),
  candidates         int not null default 0,
  papers_zip         bytea,
  papers_password    text,                            -- sealed
  papers_sha         text,
  released_at        timestamptz,
  keys_zip           bytea,
  keys_password      text,                            -- sealed
  keys_released_at   timestamptz,
  marks_submitted_at timestamptz,
  unique (cycle_id, school_id)
);

create table cwt_download (
  id          bigserial primary key,
  cycle_id    uuid not null references cwt_cycle (id),
  centre_id   uuid references cwt_centre (id),
  request_id  uuid references cwt_paper_request (id),
  kind        text not null check (kind in ('PAPERS', 'KEYS', 'REVIEW', 'PASSWORD_RESENT')),
  user_id     uuid not null references app_user (id),
  from_ip     text,
  at          timestamptz not null default now()
);
create index cwt_download_cycle on cwt_download (cycle_id, at);
create trigger cwt_download_immutable before update or delete on cwt_download for each row execute function forbid_change();

alter table job_application add column cwt_paper_id uuid references cwt_paper (id), add column cwt_raw numeric(6,2), add column cwt_absent boolean not null default false;
create unique index job_application_roll on job_application (cwt_roll_no) where cwt_roll_no is not null;
create index job_application_paper on job_application (cwt_paper_id) where cwt_paper_id is not null;
