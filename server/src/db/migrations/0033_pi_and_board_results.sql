-- The NES Performance Index (policy letter "Calculation of Performance Index"), frozen per school,
-- class and year so later years compare against what was reported; earlier years can be loaded
-- from the HQ consolidation sheets. CBSE result files are kept as uploaded, and board results reach
-- parents only when the school publishes them. Additive only.

-- One class (or stream) of one school in one year, as reported to NES.
create table pi_snapshot (
  school_id      uuid not null references org_unit (id),
  academic_year  text not null check (academic_year ~ '^\d{4}-\d{2}$'),
  class_key      text not null check (class_key ~ '^(VI|VII|VIII|IX|X)$|^(XI|XII)(-(SCIENCE|COMMERCE|HUMANITIES))?$'),
  scale          smallint not null check (scale in (7, 8)),
  students       int not null check (students >= 0),
  sum_ni         int not null check (sum_ni >= 0),
  sum_wni        int not null check (sum_wni >= 0),
  pi             numeric(6,2) check (pi between 0 and 100),
  counts         jsonb not null default '{}',     -- {A1: n, A2: n, ...}
  topper         jsonb,                           -- {name, category, total, max, pct}
  source         text not null check (source in ('SYSTEM', 'IMPORTED')),
  frozen_by      uuid not null references app_user (id),
  frozen_at      timestamptz not null default now(),
  primary key (school_id, academic_year, class_key)
);
create trigger pi_snapshot_audit after insert or update or delete on pi_snapshot for each row execute function audit_row();

-- CBSE result files exactly as the school uploaded them.
create table board_upload (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  year          smallint not null,
  class_code    text not null check (class_code in ('X', 'XII')),
  file_name     text not null,
  format        text not null check (format in ('CBSE_TXT', 'CSV')),
  content       text not null check (length(content) <= 5000000),
  rows          int not null,
  matched       int not null,
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now()
);
create trigger board_upload_immutable before update or delete on board_upload for each row execute function forbid_change();

alter table board_result add column gender text check (gender is null or gender in ('M', 'F')),
  add column stream text check (stream is null or stream in ('SCIENCE', 'COMMERCE', 'HUMANITIES')),
  add column published_at timestamptz, add column published_by uuid references app_user (id);

-- Grade weights as the policy letter sets them for Classes VI–IX and XI (A1 7 … D 1, E 0), so the
-- quick per-exam analysis agrees with the PI sheet (which divides by 7).
update grade_band set points = case grade when 'A1' then 7 when 'A2' then 6 when 'B1' then 5 when 'B2' then 4 when 'C1' then 3 when 'C2' then 2 when 'D' then 1 else 0 end where scale = 'CBSE9';
