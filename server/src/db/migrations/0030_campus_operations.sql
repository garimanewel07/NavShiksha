-- Campus operations: health and the infirmary, the gate (visitors, authorised pickup, gate
-- passes), stores and assets (indents, purchase orders, receipts, stock, asset tags, audits,
-- maintenance, depreciation), safety drills and incidents, and alumni.

-- New duties, notification kinds and the alumni role.
alter table duty drop constraint duty_code_check;
alter table duty add constraint duty_code_check check (code in ('TIMETABLE_COORDINATOR', 'EXAM_INCHARGE', 'ADMISSION_INCHARGE', 'WEBSITE_EDITOR',
  'ATTENDANCE_OFFICER', 'HOUSE_MASTER', 'TRANSPORT_INCHARGE', 'LIBRARIAN', 'COUNSELLOR', 'STAFF_RECORDS', 'RECRUITMENT_INCHARGE',
  'NURSE', 'GATE_SECURITY', 'STORE_KEEPER', 'ALUMNI_COORDINATOR', 'SAFETY_OFFICER'));
alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE', 'TRANSFER', 'CHAT', 'PAY',
                  'TRANSPORT', 'SUPPORT', 'RECRUITMENT', 'HEALTH', 'GATE', 'STORES', 'ALUMNI', 'GOVERNANCE', 'TASK', 'INSPECTION'));
alter table app_user drop constraint app_user_role_check;
alter table app_user add constraint app_user_role_check check (role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF', 'PARENT', 'SUPPORT', 'DEVELOPER', 'CANDIDATE', 'ALUMNUS'));
alter table app_user drop constraint app_user_scope;
alter table app_user add constraint app_user_scope check (role in ('PARENT', 'SUPPORT', 'DEVELOPER', 'CANDIDATE', 'ALUMNUS') or scope_path is not null);
alter table app_user drop constraint app_user_no_scope;
alter table app_user add constraint app_user_no_scope check (role not in ('SUPPORT', 'DEVELOPER', 'CANDIDATE', 'ALUMNUS') or scope_path is null);
alter table candidate_otp drop constraint candidate_otp_purpose_check;
alter table candidate_otp add constraint candidate_otp_purpose_check check (purpose in ('REGISTER', 'LOGIN', 'ALUMNI_REGISTER', 'ALUMNI_LOGIN', 'GATE'));

-- ── Health ─────────────────────────────────────────────────────────────────────────────────
-- One health record per child: kept up to date by the parent and the nurse, read by the class
-- teacher (the alert line only) and whoever has the child's health grant.
create table student_health (
  student_id      uuid primary key references student (id),
  allergies       text,
  conditions      text,
  medication      text,
  diet            text,
  alert           text,                 -- one line shown to the class teacher and on the nurse's screen
  doctor          text,
  doctor_phone    text,
  updated_by      uuid not null references app_user (id),
  updated_at      timestamptz not null default now(),
  version         int not null default 1
);
create trigger student_health_version before update on student_health for each row execute function bump_version();
create trigger student_health_audit after insert or update on student_health for each row execute function audit_row();

create table immunisation (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references student (id),
  vaccine      text not null,
  dose         text not null default '',
  given_on     date,
  due_on       date,
  recorded_by  uuid not null references app_user (id),
  check (given_on is not null or due_on is not null)
);
create index immunisation_s on immunisation (student_id);
create trigger immunisation_audit after insert or update or delete on immunisation for each row execute function audit_row();

create table health_checkup (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references student (id),
  school_id    uuid not null references org_unit (id),
  on_date      date not null,
  height_cm    numeric(5,1) check (height_cm between 40 and 230),
  weight_kg    numeric(5,1) check (weight_kg between 5 and 200),
  bmi          numeric(5,1) generated always as (case when height_cm > 0 and weight_kg > 0 then round(weight_kg / ((height_cm / 100) * (height_cm / 100)), 1) end) stored,
  vision_left  text,
  vision_right text,
  dental       text,
  hearing      text,
  notes        text,
  recorded_by  uuid not null references app_user (id),
  unique (student_id, on_date)
);
create trigger health_checkup_audit after insert or update on health_checkup for each row execute function audit_row();

create table infirmary_visit (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  student_id      uuid references student (id),
  staff_user_id   uuid references app_user (id),
  at              timestamptz not null default now(),
  complaint       text not null,
  temperature_c   numeric(4,1) check (temperature_c between 33 and 43),
  treatment       text not null default '',
  medicines       jsonb not null default '[]',   -- [{name, dose, itemId?, qty?}]
  outcome         text not null check (outcome in ('BACK_TO_CLASS', 'RESTED', 'SENT_HOME', 'HOSPITAL')),
  parent_told_at  timestamptz,
  recorded_by     uuid not null references app_user (id),
  check ((student_id is null) <> (staff_user_id is null))
);
create index infirmary_visit_s on infirmary_visit (school_id, at desc);
create trigger infirmary_visit_immutable before delete on infirmary_visit for each row execute function forbid_change();
create trigger infirmary_visit_audit after insert or update on infirmary_visit for each row execute function audit_row();

-- ── Safety: incidents and drills ───────────────────────────────────────────────────────────
create sequence incident_seq start 1;
create table incident (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique default ('INC-' || lpad(nextval('incident_seq')::text, 6, '0')),
  school_id     uuid not null references org_unit (id),
  at            timestamptz not null,
  kind          text not null check (kind in ('INJURY', 'ILLNESS', 'BEHAVIOUR', 'BULLYING', 'SAFETY', 'PROPERTY', 'CHILD_PROTECTION', 'OTHER')),
  severity      text not null check (severity in ('MINOR', 'MODERATE', 'SERIOUS')),
  place         text not null,
  description   text not null,
  action_taken  text not null default '',
  students      uuid[] not null default '{}',
  staff         uuid[] not null default '{}',
  confidential  boolean not null default false,  -- child protection: the principal and the safety officer only
  parents_told  boolean not null default false,
  status        text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  reported_by   uuid not null references app_user (id),
  closed_by     uuid references app_user (id),
  closed_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index incident_school on incident (school_id, at desc);
create trigger incident_audit after insert or update on incident for each row execute function audit_row();
create table incident_update (
  id           bigserial primary key,
  incident_id  uuid not null references incident (id),
  note         text not null,
  by_user      uuid not null references app_user (id),
  at           timestamptz not null default now()
);
create trigger incident_update_immutable before update or delete on incident_update for each row execute function forbid_change();

create table safety_drill (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references org_unit (id),
  kind               text not null check (kind in ('FIRE', 'EARTHQUAKE', 'LOCKDOWN', 'EVACUATION', 'FIRST_AID', 'OTHER')),
  on_date            date not null,
  started_at         time,
  minutes_to_clear   numeric(5,1),
  participants       int,
  observations       text not null default '',
  actions            text not null default '',
  recorded_by        uuid not null references app_user (id),
  created_at         timestamptz not null default now()
);
create trigger safety_drill_audit after insert or update on safety_drill for each row execute function audit_row();

-- ── The gate ───────────────────────────────────────────────────────────────────────────────
create sequence visitor_seq start 1;
create table visitor (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique default ('V-' || lpad(nextval('visitor_seq')::text, 7, '0')),
  school_id       uuid not null references org_unit (id),
  name            text not null check (length(trim(name)) > 1),
  phone           text,
  purpose         text not null,
  organisation    text,
  host_user_id    uuid references app_user (id),
  id_kind         text,
  id_last4        text,
  vehicle_no      text,
  photo           bytea,
  expected_on     date,
  code_hash       text,               -- the entry code sent to an expected visitor
  status          text not null check (status in ('EXPECTED', 'IN', 'OUT', 'TURNED_AWAY', 'CANCELLED')),
  in_at           timestamptz,
  out_at          timestamptz,
  badge_no        text,
  note            text,
  created_by      uuid not null references app_user (id),
  created_at      timestamptz not null default now()
);
create index visitor_school on visitor (school_id, created_at desc);
create trigger visitor_audit after insert or update on visitor for each row execute function audit_row();

-- People a parent allows to collect their child, with a photo the guard sees.
create table authorised_pickup (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references student (id),
  name         text not null,
  relation     text not null,
  phone        text,
  photo        bytea,
  photo_type   text,
  token        text not null unique,            -- in the QR on the pickup card
  active       boolean not null default true,
  added_by     uuid not null references app_user (id),
  added_at     timestamptz not null default now()
);
create index authorised_pickup_s on authorised_pickup (student_id);
create trigger authorised_pickup_audit after insert or update on authorised_pickup for each row execute function audit_row();

create sequence gate_pass_seq start 1;
create table gate_pass (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique default ('GP-' || lpad(nextval('gate_pass_seq')::text, 7, '0')),
  school_id     uuid not null references org_unit (id),
  student_id    uuid not null references student (id),
  on_date       date not null,
  leave_at      time not null,
  reason        text not null,
  pickup_id     uuid references authorised_pickup (id),   -- null: the parent who asked comes
  requested_by  uuid not null references app_user (id),
  status        text not null default 'REQUESTED' check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'LEFT', 'CANCELLED')),
  decided_by    uuid references app_user (id),
  decided_at    timestamptz,
  decision_note text,
  verified_by   uuid references app_user (id),
  left_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index gate_pass_day on gate_pass (school_id, on_date);
create trigger gate_pass_audit after insert or update on gate_pass for each row execute function audit_row();

-- ── Stores and assets ──────────────────────────────────────────────────────────────────────
insert into ledger_account (code, name, type) values
  ('1600', 'Fixed assets (furniture, equipment, IT)', 'ASSET'),
  ('1690', 'Accumulated depreciation', 'ASSET'),
  ('2600', 'Suppliers payable', 'LIABILITY'),
  ('4910', 'Sale of old assets and scrap', 'INCOME'),
  ('5400', 'Stores, stationery and consumables', 'EXPENSE'),
  ('5500', 'Depreciation', 'EXPENSE'),
  ('5510', 'Loss on assets written off', 'EXPENSE')
on conflict do nothing;

create table store_item (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  code            text not null,
  name            text not null,
  category        text not null check (category in ('STATIONERY', 'IT', 'CONSUMABLE', 'LAB', 'SPORTS', 'MEDICINE', 'FURNITURE', 'CLEANING', 'UNIFORM', 'OTHER')),
  kind            text not null check (kind in ('CONSUMABLE', 'ASSET')),
  unit            text not null default 'nos',
  reorder_level   numeric(12,2) not null default 0,
  track_expiry    boolean not null default false,
  life_years      smallint check (life_years between 1 and 50),   -- assets: for depreciation
  attributes      jsonb not null default '{}',
  active          boolean not null default true,
  unique (school_id, code)
);
create trigger store_item_audit after insert or update on store_item for each row execute function audit_row();

create table supplier (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references org_unit (id),
  name       text not null,
  gstin      text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  phone      text,
  email      text,
  address    text,
  unique (school_id, name)
);

create sequence indent_seq start 1;
create table indent (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique default ('IND-' || lpad(nextval('indent_seq')::text, 6, '0')),
  school_id     uuid not null references org_unit (id),
  department    text not null,
  purpose       text not null default '',
  needed_by     date,
  status        text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'APPROVED', 'REJECTED', 'ISSUED', 'ORDERED', 'CLOSED')),
  requested_by  uuid not null references app_user (id),
  decided_by    uuid references app_user (id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create table indent_line (
  id            uuid primary key default gen_random_uuid(),
  indent_id     uuid not null references indent (id),
  item_id       uuid references store_item (id),
  description   text not null,
  qty           numeric(12,2) not null check (qty > 0),
  est_paise     bigint not null default 0 check (est_paise >= 0)
);
create trigger indent_audit after insert or update on indent for each row execute function audit_row();

create sequence po_seq start 1;
create table purchase_order (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique default ('PO-' || lpad(nextval('po_seq')::text, 6, '0')),
  school_id     uuid not null references org_unit (id),
  supplier_id   uuid not null references supplier (id),
  indent_id     uuid references indent (id),
  status        text not null default 'DRAFT' check (status in ('DRAFT', 'ISSUED', 'PART_RECEIVED', 'RECEIVED', 'CANCELLED')),
  total_paise   bigint not null default 0,
  terms         text not null default '',
  prepared_by   uuid not null references app_user (id),
  approved_by   uuid references app_user (id),
  issued_at     timestamptz,
  created_at    timestamptz not null default now(),
  check (approved_by is null or approved_by <> prepared_by)
);
create table po_line (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references purchase_order (id),
  item_id      uuid not null references store_item (id),
  qty          numeric(12,2) not null check (qty > 0),
  unit_paise   bigint not null check (unit_paise >= 0),
  gst_pct      numeric(4,1) not null default 0 check (gst_pct between 0 and 28),
  received     numeric(12,2) not null default 0
);
create trigger purchase_order_audit after insert or update on purchase_order for each row execute function audit_row();

create sequence grn_seq start 1;
create table goods_receipt (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique default ('GRN-' || lpad(nextval('grn_seq')::text, 6, '0')),
  po_id         uuid not null references purchase_order (id),
  school_id     uuid not null references org_unit (id),
  received_on   date not null,
  invoice_no    text not null,
  invoice_date  date,
  amount_paise  bigint not null check (amount_paise >= 0),
  paid_paise    bigint not null default 0 check (paid_paise >= 0),
  received_by   uuid not null references app_user (id),
  created_at    timestamptz not null default now()
);
create trigger goods_receipt_immutable before delete on goods_receipt for each row execute function forbid_change();
create table supplier_payment (
  id            uuid primary key default gen_random_uuid(),
  grn_id        uuid not null references goods_receipt (id),
  amount_paise  bigint not null check (amount_paise > 0),
  paid_on       date not null,
  utr           text not null,
  paid_by       uuid not null references app_user (id),
  created_at    timestamptz not null default now()
);
create trigger supplier_payment_immutable before update or delete on supplier_payment for each row execute function forbid_change();

-- Every movement of stock; balances are sums (never stored), batches carry expiry dates.
create table stock_movement (
  id            bigserial primary key,
  item_id       uuid not null references store_item (id),
  school_id     uuid not null references org_unit (id),
  at            timestamptz not null default now(),
  kind          text not null check (kind in ('RECEIPT', 'ISSUE', 'RETURN', 'ADJUST', 'OPENING')),
  qty           numeric(12,2) not null check (qty <> 0),
  batch         text,
  expiry        date,
  unit_paise    bigint,
  department    text,
  issued_to     uuid references app_user (id),
  ref_type      text,
  ref_id        text,
  note          text,
  by_user       uuid not null references app_user (id)
);
create index stock_movement_item on stock_movement (item_id, at);
create trigger stock_movement_immutable before update or delete on stock_movement for each row execute function forbid_change();

create table asset (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  tag             text not null unique,
  item_id         uuid references store_item (id),
  name            text not null,
  serial_no       text,
  location        text not null default '',
  custodian       uuid references app_user (id),
  acquired_on     date not null,
  cost_paise      bigint not null check (cost_paise >= 0),
  life_years      smallint not null default 5 check (life_years between 1 and 50),
  depreciated_paise bigint not null default 0,
  grn_id          uuid references goods_receipt (id),
  status          text not null default 'IN_USE' check (status in ('IN_USE', 'IN_REPAIR', 'MISSING', 'DISPOSED')),
  disposed_on     date,
  disposal_paise  bigint,
  disposal_note   text,
  updated_at      timestamptz not null default now(),
  version         int not null default 1,
  check (depreciated_paise <= cost_paise)
);
create index asset_school on asset (school_id, status);
create trigger asset_version before update on asset for each row execute function bump_version();
create trigger asset_audit after insert or update on asset for each row execute function audit_row();

create table asset_maintenance (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references asset (id),
  kind          text not null,
  every_months  smallint check (every_months between 1 and 60),
  due_on        date not null,
  done_on       date,
  vendor        text,
  cost_paise    bigint,
  note          text,
  by_user       uuid references app_user (id)
);
create index asset_maintenance_due on asset_maintenance (due_on) where done_on is null;

create table depreciation_run (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  fy           text not null check (fy ~ '^\d{4}-\d{2}$'),
  amount_paise bigint not null,
  run_by       uuid not null references app_user (id),
  run_at       timestamptz not null default now(),
  unique (school_id, fy)
);

create table stock_audit (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  title        text not null,
  status       text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  started_by   uuid not null references app_user (id),
  started_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create table stock_audit_scan (
  audit_id   uuid not null references stock_audit (id),
  asset_id   uuid not null references asset (id),
  location   text,
  by_user    uuid not null references app_user (id),
  at         timestamptz not null default now(),
  primary key (audit_id, asset_id)
);

-- ── Alumni ─────────────────────────────────────────────────────────────────────────────────
-- Former pupils' records (imported from the old ERP, or matched for alumni) go back further.
alter table student drop constraint student_dob_check;
alter table student add constraint student_dob_check check (dob > date '1960-01-01');
create sequence alumnus_seq start 1;
create table alumnus (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique default ('AL-' || lpad(nextval('alumnus_seq')::text, 6, '0')),
  school_id       uuid not null references org_unit (id),
  student_id      uuid references student (id),          -- matched to the school's record of a former pupil
  name            text not null,
  email           text not null,
  mobile          text not null,
  dob             date,
  left_year       smallint not null check (left_year between 1950 and 2100),
  last_class      text,
  city            text,
  occupation      text,
  organisation    text,
  in_directory    boolean not null default false,          -- consent to be listed for other alumni
  status          text not null default 'PENDING' check (status in ('PENDING', 'VERIFIED', 'REJECTED')),
  verified_by     uuid references app_user (id),
  verified_at     timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  unique (school_id, email)
);
create index alumnus_school on alumnus (school_id, status, left_year);
create trigger alumnus_audit after insert or update on alumnus for each row execute function audit_row();
alter table app_user add column alumnus_id uuid unique references alumnus (id);
alter table app_user add constraint app_user_alumnus check ((role = 'ALUMNUS') = (alumnus_id is not null));

create table alumni_event (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  title        text not null,
  kind         text not null check (kind in ('REUNION', 'NEWSLETTER', 'TALK', 'OTHER')),
  on_date      date,
  venue        text,
  body         text not null,
  batches      smallint[] not null default '{}',      -- empty: every batch
  sent_at      timestamptz,
  created_by   uuid not null references app_user (id),
  created_at   timestamptz not null default now()
);
create table alumni_rsvp (
  event_id    uuid not null references alumni_event (id),
  alumnus_id  uuid not null references alumnus (id),
  answer      text not null check (answer in ('YES', 'NO', 'MAYBE')),
  guests      smallint not null default 0 check (guests between 0 and 5),
  at          timestamptz not null default now(),
  primary key (event_id, alumnus_id)
);
