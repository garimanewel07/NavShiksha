-- Recruitment: candidates register once and apply to any school's vacancies, year after year.
-- Applications keep a frozen copy of the profile at submission; the sort keys are columns so a
-- school can filter and order a lakh of applications instantly.

-- ── Candidates (one record per person, for life) ───────────────────────────────────────────
create sequence candidate_seq start 100001;
create table candidate (
  id                 uuid primary key default gen_random_uuid(),
  candidate_no       text not null unique default ('NES-CN-' || nextval('candidate_seq')),
  email              text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  mobile             text not null unique check (mobile ~ '^\+91[6-9][0-9]{9}$'),
  name               text not null check (length(trim(name)) > 2),
  father_name        text,
  mother_name        text,
  spouse_name        text,
  dob                date not null check (dob > date '1950-01-01'),
  gender             text not null check (gender in ('F', 'M', 'X')),
  category           text not null default 'GEN' check (category in ('GEN', 'OBC', 'SC', 'ST', 'EWS')),
  pwd                boolean not null default false,
  pwd_type           text,
  ex_serviceman      boolean not null default false,
  navy_relation      text not null default 'NONE' check (navy_relation in ('NONE', 'NAVY_SERVING', 'NAVY_RETIRED', 'NAVY_SPOUSE', 'NAVY_WARD', 'DEF_CIVILIAN')),
  nationality        text not null default 'Indian',
  address            text,
  city               text,
  state              text,
  pincode            text check (pincode ~ '^[1-9][0-9]{5}$'),
  aadhaar_last4      text,
  aadhaar_cipher     text,
  email_verified_at  timestamptz,
  mobile_verified_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            int not null default 1
);
create unique index candidate_email on candidate (lower(email));
create trigger candidate_version before update on candidate for each row execute function bump_version();
create trigger candidate_audit after insert or update on candidate for each row execute function audit_row();
alter table app_user add constraint app_user_candidate_fk foreign key (candidate_id) references candidate (id);

create table candidate_education (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references candidate (id),
  level          text not null check (level in ('SECONDARY', 'SR_SECONDARY', 'DIPLOMA', 'GRADUATION', 'POST_GRADUATION', 'BED', 'DELED', 'NTT', 'MED', 'MPHIL', 'PHD', 'OTHER')),
  degree         text not null,
  subjects       text[] not null default '{}',             -- subject codes (MAT, PHY…) or names
  institution    text,
  year           smallint check (year between 1960 and 2100),
  percentage     numeric(5,2) check (percentage between 0 and 100),
  status         text not null default 'PASSED' check (status in ('PASSED', 'APPEARING'))
);
create index candidate_education_c on candidate_education (candidate_id);
create table candidate_test (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references candidate (id),
  kind           text not null check (kind in ('CTET', 'STET', 'TET', 'NET', 'SET', 'OTHER')),
  paper          text not null default '',                  -- I, II, a subject
  year           smallint,
  score          numeric(6,2),
  qualified      boolean not null default true,
  valid_until    date
);
create index candidate_test_c on candidate_test (candidate_id);
create table candidate_experience (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references candidate (id),
  organisation   text not null,
  post           text not null,
  subject        text,
  from_date      date not null,
  to_date        date,
  teaching       boolean not null default true,
  cbse           boolean not null default false,
  check (to_date is null or to_date >= from_date)
);
create index candidate_experience_c on candidate_experience (candidate_id);
create table candidate_document (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references candidate (id),
  kind           text not null check (kind in ('PHOTO', 'SIGNATURE', 'ID_PROOF', 'EDUCATION', 'CATEGORY', 'PWD', 'ESM', 'EXPERIENCE', 'TEST', 'OTHER')),
  name           text not null,
  content_type   text not null check (content_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size           int not null check (size between 1 and 2097152),
  sha256         text not null,
  data           bytea not null,
  uploaded_at    timestamptz not null default now()
);
create index candidate_document_c on candidate_document (candidate_id, kind);

-- One-time codes for registering and signing in (hashed; five tries; ten minutes).
create table candidate_otp (
  id           bigserial primary key,
  destination  text not null,
  purpose      text not null check (purpose in ('REGISTER', 'LOGIN')),
  code_hash    text not null,
  attempts     smallint not null default 0,
  used_at      timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index candidate_otp_dest on candidate_otp (destination, created_at desc);

-- ── Vacancies ──────────────────────────────────────────────────────────────────────────────
create table vacancy (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  code           text not null unique,
  post_id        uuid references post (id),
  post_type      text not null references post_type (code),
  subject_code   text references subject (code),
  title          text not null check (length(trim(title)) > 4),
  employment     text not null check (employment in ('PERMANENT', 'CONTRACT', 'TEMPORARY', 'PART_TIME', 'GUEST', 'DAILY_WAGE', 'DEPUTATION')),
  positions      smallint not null default 1 check (positions between 1 and 500),
  pay_text       text not null default '',
  description    text not null default '',
  eligibility    jsonb not null,
  fees           jsonb not null default '{}',                -- {"GEN": paise, "OBC": …, "EWS": …, "SC": 0, "ST": 0, "PWD": 0, "ESM": 0, "WOMEN": null}
  questions      jsonb not null default '[]',
  weights        jsonb not null default '{"cwt": 60, "interview": 30, "academic": 10}',
  declaration    text not null,
  opens_on       date not null,
  closes_on      date not null check (closes_on >= opens_on),
  age_as_on      date not null,
  cwt            boolean not null default false,
  interview      boolean not null default true,
  status         text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED', 'FILLED')),
  created_by     uuid not null references app_user (id),
  published_by   uuid references app_user (id),
  published_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index vacancy_open on vacancy (status, closes_on);
create trigger vacancy_audit after insert or update on vacancy for each row execute function audit_row();

-- ── Applications ───────────────────────────────────────────────────────────────────────────
create sequence job_application_seq start 1;
create table job_application (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique default ('NJA-' || lpad(nextval('job_application_seq')::text, 8, '0')),
  vacancy_id        uuid not null references vacancy (id),
  candidate_id      uuid not null references candidate (id),
  snapshot          jsonb not null,                          -- the profile as submitted
  answers           jsonb not null default '{}',
  eligibility       jsonb not null,
  -- Sort and filter keys, worked out at submission.
  category          text not null,
  gender            text not null,
  pwd               boolean not null default false,
  ex_serviceman     boolean not null default false,
  navy_relation     text not null default 'NONE',
  age_years         numeric(5,2) not null,
  qual_pct          numeric(5,2),                            -- the required qualification's percentage
  pg_pct            numeric(5,2),
  bed_pct           numeric(5,2),
  test_score        numeric(6,2),
  experience_months int not null default 0,
  city              text,
  search            text not null,                           -- name, number, email, mobile in lower case
  cwt_roll_no       text,
  cwt_marks         numeric(6,2),
  interview_marks   numeric(6,2),
  merit             numeric(7,3),
  fee_paise         bigint not null default 0,
  fee_status        text not null check (fee_status in ('NOT_REQUIRED', 'DUE', 'PAID', 'REFUNDED')),
  receipt_no        text,
  paid_at           timestamptz,
  status            text not null check (status in ('FEE_DUE', 'SUBMITTED', 'SHORTLISTED', 'CWT', 'INTERVIEW', 'SELECTED', 'WAITLISTED', 'REJECTED', 'NOT_SELECTED', 'WITHDRAWN', 'APPOINTED')),
  tags              text[] not null default '{}',
  school_note       text,
  declared_at       timestamptz not null,
  declared_from     text,
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  appointed_user_id uuid references app_user (id),
  unique (vacancy_id, candidate_id)
);
create index job_application_v_status on job_application (vacancy_id, status);
create index job_application_v_merit on job_application (vacancy_id, merit desc nulls last);
create index job_application_v_qual on job_application (vacancy_id, qual_pct desc nulls last);
create index job_application_v_test on job_application (vacancy_id, test_score desc nulls last);
create index job_application_v_exp on job_application (vacancy_id, experience_months desc);
create index job_application_v_created on job_application (vacancy_id, created_at);
create index job_application_c on job_application (candidate_id);
create trigger job_application_audit after update on job_application for each row execute function audit_row();

create table job_application_event (
  id              bigserial primary key,
  application_id  uuid not null references job_application (id),
  from_status     text,
  to_status       text not null,
  note            text,
  by_user         uuid references app_user (id),
  at              timestamptz not null default now()
);
create index job_application_event_a on job_application_event (application_id, id);

-- Application fees: paid to the school that posted the vacancy, never to NES.
insert into ledger_account (code, name, type) values ('4170', 'Recruitment application fees', 'INCOME') on conflict do nothing;
create table job_payment (
  id                uuid primary key default gen_random_uuid(),
  application_id    uuid not null references job_application (id),
  amount_paise      bigint not null check (amount_paise > 0),
  status            text not null default 'CREATED' check (status in ('CREATED', 'CAPTURED', 'FAILED')),
  gateway_order_id  text not null unique,
  receipt_no        text unique,
  created_at        timestamptz not null default now(),
  captured_at       timestamptz
);

-- Interviews, demonstration classes and document checks.
create table interview_round (
  id            uuid primary key default gen_random_uuid(),
  vacancy_id    uuid not null references vacancy (id),
  kind          text not null check (kind in ('INTERVIEW', 'DEMO', 'DOCUMENTS')),
  title         text not null,
  on_date       date not null,
  venue         text not null,
  bring         text not null default '',
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now()
);
create table interview_slot (
  id              uuid primary key default gen_random_uuid(),
  round_id        uuid not null references interview_round (id),
  application_id  uuid not null references job_application (id),
  starts_at       timestamptz not null,
  status          text not null default 'INVITED' check (status in ('INVITED', 'CONFIRMED', 'ATTENDED', 'ABSENT', 'CANCELLED')),
  marks           numeric(6,2),
  note            text,
  unique (round_id, application_id)
);
create index interview_slot_a on interview_slot (application_id);

-- The recruitment in-charge: a duty the principal gives.
alter table duty drop constraint duty_code_check;
alter table duty add constraint duty_code_check check (code in ('TIMETABLE_COORDINATOR', 'EXAM_INCHARGE', 'ADMISSION_INCHARGE', 'WEBSITE_EDITOR',
  'ATTENDANCE_OFFICER', 'HOUSE_MASTER', 'TRANSPORT_INCHARGE', 'LIBRARIAN', 'COUNSELLOR', 'STAFF_RECORDS', 'RECRUITMENT_INCHARGE'));
