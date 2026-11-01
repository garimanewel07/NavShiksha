-- R4: staff, salary and deductions. Each school manages its own salaries: it defines its own pay
-- structures (regular, contract, guest, daily wage…), its own pay scales and components, with
-- dates and two-person approval. Only what the law fixes is common: PF, ESI, professional tax by
-- state and income tax. NES handles no money and only sees the picture. A locked payroll run is
-- permanent and every payslip line keeps the rule and inputs it used. Additive only.

insert into ledger_account (code, name, type) values
  ('1500', 'Staff loans and advances', 'ASSET'),
  ('2500', 'Salaries payable', 'LIABILITY'),
  ('2510', 'Provident fund payable', 'LIABILITY'),
  ('2511', 'ESI payable', 'LIABILITY'),
  ('2520', 'Professional tax payable', 'LIABILITY'),
  ('2530', 'Income tax deducted at source payable', 'LIABILITY'),
  ('2540', 'Other salary deductions payable', 'LIABILITY'),
  ('5300', 'Salaries and allowances', 'EXPENSE'),
  ('5310', 'Employer provident fund and EDLI', 'EXPENSE'),
  ('5311', 'Employer ESI', 'EXPENSE'),
  ('5320', 'Gratuity and leave encashment', 'EXPENSE');

-- ── Employees: one NES staff ID for life ───────────────────────────────────────────────────
create sequence nes_staff_seq start 100001;
create table employee (
  user_id          uuid primary key references app_user (id),
  nes_staff_id     text not null unique default ('NES-ST-' || nextval('nes_staff_seq')),
  school_id        uuid not null references org_unit (id),      -- the school that pays them now
  -- Permanent (on probation until confirmed), contract (fixed term, renewed by order), temporary or
  -- ad hoc, part-time, guest (paid per period), daily wage, or on deputation from another office.
  employment       text not null check (employment in ('PERMANENT', 'CONTRACT', 'TEMPORARY', 'PART_TIME', 'GUEST', 'DAILY_WAGE', 'DEPUTATION')),
  contract_until   date,                                          -- contract and temporary staff: when the term ends
  category         text not null default 'TEACHING' check (category in ('TEACHING', 'NON_TEACHING')),
  gender           text check (gender in ('F', 'M', 'X')),
  joined_service   date not null,
  probation_until  date,
  confirmed_on     date,
  retirement_on    date,
  separated_on     date,
  separation_reason text,
  -- Identity numbers are stored encrypted (application key) with only the last digits in clear.
  pan_last4        text check (pan_last4 ~ '^[A-Z0-9]{4}$'),
  pan_cipher       text,
  aadhaar_last4    text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  aadhaar_cipher   text,
  uan              text check (uan ~ '^[0-9]{12}$'),
  esi_no           text check (esi_no ~ '^[0-9]{10,17}$'),
  version          int not null default 1,
  updated_at       timestamptz not null default now(),
  check ((pan_last4 is null) = (pan_cipher is null)),
  check ((aadhaar_last4 is null) = (aadhaar_cipher is null)),
  check (separated_on is null or separated_on >= joined_service),
  check (employment not in ('CONTRACT', 'TEMPORARY') or contract_until is not null),
  check ((separated_on is null) = (separation_reason is null))
);
create trigger employee_version before update on employee for each row execute function bump_version();
create trigger employee_audit after insert or update on employee for each row execute function audit_row();

-- Who looked at a full identity or bank number, and why.
create table pii_view (
  id          bigserial primary key,
  user_id     uuid not null references app_user (id),          -- whose number
  field       text not null,
  viewed_by   uuid not null references app_user (id),
  purpose     text not null,
  viewed_at   timestamptz not null default now()
);
create trigger pii_view_immutable before update or delete on pii_view for each row execute function forbid_change();

-- Bank accounts: a change is verified by a second person and only reaches salary after a cooling-off.
create table employee_bank (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user (id),
  account_last4   text not null check (account_last4 ~ '^[0-9]{4}$'),
  account_cipher  text not null,
  ifsc            text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name       text not null check (length(trim(bank_name)) > 1),
  holder_name     text not null check (length(trim(holder_name)) > 1),
  status          text not null default 'PENDING' check (status in ('PENDING', 'VERIFIED', 'REJECTED')),
  requested_by    uuid not null references app_user (id),
  requested_at    timestamptz not null default now(),
  verified_by     uuid references app_user (id),
  verified_at     timestamptz,
  note            text,
  check (verified_by is null or verified_by <> requested_by),
  check ((status = 'PENDING') = (verified_by is null))
);
create index employee_bank_user on employee_bank (user_id, status, verified_at desc);
create function bank_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'bank records are kept' using errcode = 'check_violation'; end if;
  if old.status <> 'PENDING' then raise exception 'a verified or rejected bank record cannot change; add a new one' using errcode = 'check_violation'; end if;
  if (new.account_cipher, new.ifsc, new.user_id) is distinct from (old.account_cipher, old.ifsc, old.user_id) then
    raise exception 'the account cannot change after the request; make a new request' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger employee_bank_guard before update or delete on employee_bank for each row execute function bank_guard();
create trigger employee_bank_audit after insert or update on employee_bank for each row execute function audit_row();

-- ── Posts and appointments ─────────────────────────────────────────────────────────────────
create table post_type (
  code      text primary key,
  name      text not null,
  category  text not null check (category in ('TEACHING', 'NON_TEACHING')),
  ordinal   smallint not null
);
insert into post_type (code, name, category, ordinal) values
  ('PRINCIPAL', 'Principal', 'TEACHING', 1), ('VICE_PRINCIPAL', 'Vice Principal', 'TEACHING', 2), ('HEADMISTRESS', 'Headmistress (primary)', 'TEACHING', 3),
  ('PGT', 'Post Graduate Teacher', 'TEACHING', 4), ('TGT', 'Trained Graduate Teacher', 'TEACHING', 5), ('PRT', 'Primary Teacher', 'TEACHING', 6),
  ('BALVATIKA', 'Balvatika teacher', 'TEACHING', 7), ('SPECIAL_EDUCATOR', 'Special educator', 'TEACHING', 8), ('COUNSELLOR', 'Counsellor', 'TEACHING', 9),
  ('LIBRARIAN', 'Librarian', 'TEACHING', 10), ('PTI', 'Physical training instructor', 'TEACHING', 11),
  ('OFFICE_SUPDT', 'Office superintendent', 'NON_TEACHING', 12), ('ACCOUNTANT', 'Accountant', 'NON_TEACHING', 13), ('CLERK', 'Office clerk', 'NON_TEACHING', 14),
  ('LAB_ATTENDANT', 'Laboratory attendant', 'NON_TEACHING', 15), ('NURSE', 'Nurse', 'NON_TEACHING', 16), ('SUPPORT', 'Support staff', 'NON_TEACHING', 17);

create table post (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  post_type      text not null references post_type (code),
  subject_code   text references subject (code),
  pay_level      smallint check (pay_level between 1 and 18),
  sanctioned     daterange not null,                           -- from the sanction order until abolished
  order_ref      text not null check (length(trim(order_ref)) > 1),
  created_by     uuid not null references app_user (id),
  created_at     timestamptz not null default now()
);
create index post_school on post (school_id);
create trigger post_audit after insert or update on post for each row execute function audit_row();

create table appointment (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references post (id),
  user_id     uuid not null references app_user (id),
  valid       daterange not null check (not isempty(valid)),
  order_ref   text not null check (length(trim(order_ref)) > 1),
  created_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now(),
  exclude using gist (post_id with =, valid with &&),             -- one person per post at a time
  exclude using gist (user_id with =, valid with &&)              -- one post per person at a time
);
create trigger appointment_audit after insert or update on appointment for each row execute function audit_row();

-- The service book: a permanent timeline. A correction is a new entry that cites the one it corrects.
create table service_event (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user (id),
  school_id    uuid not null references org_unit (id),
  kind         text not null check (kind in ('JOINED', 'PROBATION', 'CONFIRMED', 'CONTRACT_RENEWED', 'MADE_PERMANENT', 'INCREMENT', 'PROMOTION', 'PAY_FIXED', 'TRANSFER', 'LEAVE',
                                             'TRAINING', 'AWARD', 'PENALTY', 'SEPARATION', 'CORRECTION', 'NOTE')),
  on_date      date not null,
  summary      text not null check (length(trim(summary)) > 2 and length(summary) <= 300),
  details      jsonb not null default '{}',
  order_ref    text,
  corrects     uuid references service_event (id),
  recorded_by  uuid not null references app_user (id),
  recorded_at  timestamptz not null default now(),
  check ((kind = 'CORRECTION') = (corrects is not null))
);
create index service_event_user on service_event (user_id, on_date);
create trigger service_event_immutable before update or delete on service_event for each row execute function forbid_change();

-- ── The law: statutory rates and slabs (kept centrally; schools cannot change the law) ─────
-- PF and ESI percentages and ceilings, income-tax standard deduction, rebate limit and cess: one
-- value per code per date, approved by a second person. A change in law is a new dated row.
create table statutory_rate (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^[A-Z0-9_]{2,40}$'),
  value        numeric(14,4) not null,
  valid        daterange not null check (not isempty(valid)),
  source       text not null check (length(trim(source)) > 1),   -- the notification or order
  status       text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'REJECTED')),
  loaded       boolean not null default false,                    -- came with the system (the law as published)
  created_by   uuid references app_user (id),
  approved_by  uuid references app_user (id),
  approved_at  timestamptz,
  check (loaded or created_by is not null),
  check (approved_by is null or approved_by <> created_by),
  check ((status = 'APPROVED') = (approved_by is not null or loaded)),
  exclude using gist (code with =, valid with &&) where (status = 'APPROVED')
);
create function approved_rule_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'APPROVED' then raise exception 'an approved rule is kept; end it with a new rule' using errcode = 'check_violation'; end if;
    return old;
  end if;
  if old.status = 'REJECTED' then raise exception 'a rejected rule is closed' using errcode = 'check_violation'; end if;
  if old.status = 'APPROVED' and lower(new.valid) is distinct from lower(old.valid) then
    raise exception 'an approved rule cannot change; only its end date can be set' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger statutory_rate_guard before update or delete on statutory_rate for each row execute function approved_rule_guard();
create trigger statutory_rate_audit after insert or update on statutory_rate for each row execute function audit_row();

-- The law as loaded with the system (amounts in paise, percentages as numbers). Confirm against
-- the official notifications before go-live; a change is a new dated row approved by two people.
insert into statutory_rate (code, value, valid, source, status, loaded) values
  ('PF_EMP_PCT', 12, daterange('2014-09-01', null), 'EPF Scheme, 1952', 'APPROVED', true),
  ('PF_ER_EPF_PCT', 3.67, daterange('2014-09-01', null), 'EPF Scheme, 1952', 'APPROVED', true),
  ('PF_ER_EPS_PCT', 8.33, daterange('2014-09-01', null), 'Employees'' Pension Scheme, 1995', 'APPROVED', true),
  ('PF_CEILING', 1500000, daterange('2014-09-01', '2026-09-17'), 'EPF wage ceiling ₹15,000', 'APPROVED', true),
  ('PF_CEILING', 2500000, daterange('2026-09-17', null), 'EPF wage ceiling ₹25,000 from 17 Sep 2026', 'APPROVED', true),
  ('EPS_CEILING', 1500000, daterange('2014-09-01', null), 'EPS wage ceiling ₹15,000', 'APPROVED', true),
  ('EDLI_PCT', 0.5, daterange('2014-09-01', null), 'EDLI Scheme, 1976', 'APPROVED', true),
  ('PF_ADMIN_PCT', 0.5, daterange('2017-06-01', null), 'EPFO administrative charges', 'APPROVED', true),
  ('ESI_EMP_PCT', 0.75, daterange('2019-07-01', null), 'ESI contribution rates', 'APPROVED', true),
  ('ESI_ER_PCT', 3.25, daterange('2019-07-01', null), 'ESI contribution rates', 'APPROVED', true),
  ('ESI_CEILING', 2100000, daterange('2017-01-01', null), 'ESI wage ceiling ₹21,000', 'APPROVED', true),
  ('STD_DED_NEW', 7500000, daterange('2024-04-01', null), 'Standard deduction, new regime', 'APPROVED', true),
  ('STD_DED_OLD', 5000000, daterange('2019-04-01', null), 'Standard deduction, old regime', 'APPROVED', true),
  ('REBATE_NEW_LIMIT', 120000000, daterange('2025-04-01', null), 'Rebate: no tax up to ₹12 lakh (new regime)', 'APPROVED', true),
  ('REBATE_NEW_MAX', 6000000, daterange('2025-04-01', null), 'Rebate up to ₹60,000 (new regime)', 'APPROVED', true),
  ('REBATE_OLD_LIMIT', 50000000, daterange('2019-04-01', null), 'Rebate up to ₹5 lakh (old regime)', 'APPROVED', true),
  ('REBATE_OLD_MAX', 1250000, daterange('2019-04-01', null), 'Rebate up to ₹12,500 (old regime)', 'APPROVED', true),
  ('CESS_PCT', 4, daterange('2018-04-01', null), 'Health and education cess', 'APPROVED', true),
  ('GRATUITY_CEILING', 200000000, daterange('2018-03-29', null), 'Gratuity ceiling ₹20 lakh', 'APPROVED', true),
  ('GRATUITY_MIN_YEARS', 5, daterange('1972-01-01', null), 'Payment of Gratuity Act, 1972', 'APPROVED', true),
  ('EL_ENCASH_MAX_DAYS', 300, daterange('2008-09-01', null), 'Earned leave encashment limit', 'APPROVED', true);

-- Professional tax by state: monthly slab on gross pay, with a different amount in some months.
create table pt_slab (
  id              uuid primary key default gen_random_uuid(),
  state           text not null check (state ~ '^[A-Z]{2}$'),
  from_paise      bigint not null check (from_paise >= 0),
  to_paise        bigint,                                          -- null: no upper limit
  amount_paise    bigint not null check (amount_paise >= 0),
  february_paise  bigint,                                          -- Maharashtra: ₹300 in February
  valid           daterange not null
);
-- Income-tax slabs per regime: tax at `rate` on income above `from_paise` (up to the next slab).
create table tax_slab (
  id          uuid primary key default gen_random_uuid(),
  regime      text not null check (regime in ('NEW', 'OLD')),
  from_paise  bigint not null check (from_paise >= 0),
  rate        numeric(5,2) not null check (rate between 0 and 100),
  valid       daterange not null,
  exclude using gist (regime with =, from_paise with =, valid with &&)
);
insert into pt_slab (state, from_paise, to_paise, amount_paise, february_paise, valid) values
  -- Maharashtra
  ('MH', 0, 750000, 0, null, daterange('2023-04-01', null)), ('MH', 750001, 1000000, 17500, null, daterange('2023-04-01', null)), ('MH', 1000001, null, 20000, 30000, daterange('2023-04-01', null)),
  -- Andhra Pradesh
  ('AP', 0, 1500000, 0, null, daterange('2013-04-01', null)), ('AP', 1500001, 2000000, 15000, null, daterange('2013-04-01', null)), ('AP', 2000001, null, 20000, null, daterange('2013-04-01', null)),
  -- Goa
  ('GA', 0, 1500000, 0, null, daterange('2013-04-01', null)), ('GA', 1500001, 2500000, 15000, null, daterange('2013-04-01', null)), ('GA', 2500001, null, 20000, null, daterange('2013-04-01', null)),
  -- Kerala (levied half-yearly; shown here as the monthly share)
  ('KL', 0, 1199900, 0, null, daterange('2023-04-01', null)), ('KL', 1200000, 1799900, 2000, null, daterange('2023-04-01', null)), ('KL', 1800000, 2999900, 3000, null, daterange('2023-04-01', null)),
  ('KL', 3000000, 4499900, 5000, null, daterange('2023-04-01', null)), ('KL', 4500000, 7499900, 10000, null, daterange('2023-04-01', null)), ('KL', 7500000, 9999900, 12500, null, daterange('2023-04-01', null)),
  ('KL', 10000000, 12499900, 16700, null, daterange('2023-04-01', null)), ('KL', 12500000, null, 20800, null, daterange('2023-04-01', null));
-- Delhi and the Andaman and Nicobar Islands levy no professional tax: no rows.
insert into tax_slab (regime, from_paise, rate, valid) values
  ('NEW', 0, 0, daterange('2025-04-01', null)), ('NEW', 40000000, 5, daterange('2025-04-01', null)), ('NEW', 80000000, 10, daterange('2025-04-01', null)),
  ('NEW', 120000000, 15, daterange('2025-04-01', null)), ('NEW', 160000000, 20, daterange('2025-04-01', null)), ('NEW', 200000000, 25, daterange('2025-04-01', null)), ('NEW', 240000000, 30, daterange('2025-04-01', null)),
  ('OLD', 0, 0, daterange('2019-04-01', null)), ('OLD', 25000000, 5, daterange('2019-04-01', null)), ('OLD', 50000000, 20, daterange('2019-04-01', null)), ('OLD', 100000000, 30, daterange('2019-04-01', null));

-- ── The school's own pay: structures, components, scales ──────────────────────────────────
-- A school has as many pay structures as it needs ("Regular staff", "Contract teachers",
-- "Guest teachers per period", "Support staff daily wage"). NES may publish templates
-- (school_id null) that a school copies and changes.
create table pay_structure (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid references org_unit (id),                     -- null: an NES template
  name         text not null check (length(trim(name)) between 2 and 80),
  description  text not null default '',
  pf           text not null default 'CEILING' check (pf in ('NONE', 'CEILING', 'ACTUAL')),  -- provident fund on the ceiling, on actual wages, or not at all
  esi          boolean not null default true,                     -- ESI where the law requires it (gross up to the ceiling)
  pt           boolean not null default true,                     -- professional tax of the school's state
  tds          boolean not null default true,
  active       boolean not null default true,
  created_by   uuid not null references app_user (id),
  created_at   timestamptz not null default now(),
  unique (school_id, name)
);
create trigger pay_structure_audit after insert or update on pay_structure for each row execute function audit_row();

-- The components of a structure, each with dates. A change (DA from 60% to 63% from 1 July) is a
-- new row from its date, proposed by one person and approved by another; arrears follow.
--   BASE      the person's own amount (their basic, or consolidated pay), or their scale step
--   PERCENT   a percentage of other components (DA = 60% of BASIC; HRA = 30% of BASIC)
--   FLAT      the same amount for everyone on the structure (transport ₹3,600)
--   PER_UNIT  a rate times units: periods taught, days worked, hours (from the month's inputs or attendance)
create table pay_structure_component (
  id             uuid primary key default gen_random_uuid(),
  structure_id   uuid not null references pay_structure (id),
  code           text not null check (code ~ '^[A-Z][A-Z0-9_]{1,29}$' and code not in ('PF', 'ESI', 'PT', 'TDS', 'LOP', 'LOAN', 'GRATUITY', 'LEAVE_ENCASH', 'ARREARS') and code not like 'ER\_%'),
  name           text not null check (length(trim(name)) > 1),
  kind           text not null check (kind in ('EARNING', 'DEDUCTION')),
  calc           text not null check (calc in ('BASE', 'PERCENT', 'FLAT', 'PER_UNIT')),
  percent        numeric(7,3),
  of_codes       text[],                                           -- PERCENT: which components
  amount_paise   bigint,                                           -- FLAT, or PER_UNIT rate
  unit           text check (unit in ('PERIODS', 'DAYS_PRESENT', 'HOURS')),
  taxable        boolean not null default true,
  pf_wage        boolean not null default false,                   -- counts towards PF wages (basic, DA)
  prorate        boolean not null default true,                    -- reduced for days not paid (joining, loss of pay)
  ordinal        smallint not null,
  valid          daterange not null check (not isempty(valid)),
  status         text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'REJECTED')),
  created_by     uuid not null references app_user (id),
  approved_by    uuid references app_user (id),
  approved_at    timestamptz,
  check (approved_by is null or approved_by <> created_by),
  check ((status = 'APPROVED') = (approved_by is not null)),
  check (calc <> 'PERCENT' or (percent is not null and percent between 0 and 1000 and cardinality(of_codes) > 0)),
  check (calc <> 'FLAT' or amount_paise is not null),
  check (calc <> 'PER_UNIT' or (amount_paise is not null and unit is not null)),
  check (calc <> 'BASE' or kind = 'EARNING'),
  exclude using gist (structure_id with =, code with =, valid with &&) where (status = 'APPROVED')
);
create trigger pay_structure_component_guard before update or delete on pay_structure_component for each row execute function approved_rule_guard();
create trigger pay_structure_component_audit after insert or update on pay_structure_component for each row execute function audit_row();

-- A school's pay scales: steps from the first to the last, for yearly increments.
create table pay_scale (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid references org_unit (id),                     -- null: an NES template
  name         text not null check (length(trim(name)) > 1),
  steps_paise  bigint[] not null check (cardinality(steps_paise) between 1 and 60),
  increment_month smallint not null default 7 check (increment_month between 1 and 12),
  valid        daterange not null,
  created_by   uuid not null references app_user (id),
  approved_by  uuid references app_user (id),
  check (approved_by is null or approved_by <> created_by),
  unique (school_id, name, valid)
);
create trigger pay_scale_audit after insert or update on pay_scale for each row execute function audit_row();

-- ── What each person is paid ───────────────────────────────────────────────────────────────
-- Their structure, and their own base: an amount, or a step on one of the school's scales.
create table employee_pay (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references app_user (id),
  structure_id   uuid not null references pay_structure (id),
  valid          daterange not null check (not isempty(valid)),
  base_paise     bigint check (base_paise > 0),
  scale_id       uuid references pay_scale (id),
  step           smallint check (step >= 1),
  order_ref      text not null,
  recorded_by    uuid not null references app_user (id),
  recorded_at    timestamptz not null default now(),
  check ((scale_id is null) = (step is null)),
  exclude using gist (user_id with =, valid with &&)
);
create trigger employee_pay_audit after insert or update on employee_pay for each row execute function audit_row();

-- Allowances and deductions for one person (headship, hostel duty, society subscription, court
-- attachment), with an amount and dates.
create table employee_component (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user (id),
  code            text not null check (code ~ '^[A-Z][A-Z0-9_]{1,29}$' and code not in ('PF', 'ESI', 'PT', 'TDS', 'LOP', 'LOAN', 'GRATUITY', 'LEAVE_ENCASH', 'ARREARS')),
  name            text not null,
  kind            text not null check (kind in ('EARNING', 'DEDUCTION')),
  taxable         boolean not null default true,
  amount_paise    bigint not null check (amount_paise > 0),
  valid           daterange not null check (not isempty(valid)),
  note            text not null check (length(trim(note)) > 2),
  created_by      uuid not null references app_user (id),
  approved_by     uuid references app_user (id),
  check (approved_by is null or approved_by <> created_by),
  exclude using gist (user_id with =, code with =, valid with &&)
);
create trigger employee_component_audit after insert or update on employee_component for each row execute function audit_row();

-- The month's inputs a structure needs: periods taught by guest teachers, hours, extra days.
create table payroll_input (
  school_id    uuid not null references org_unit (id),
  month        date not null check (extract(day from month) = 1),
  user_id      uuid not null references app_user (id),
  unit         text not null check (unit in ('PERIODS', 'HOURS', 'DAYS_PRESENT')),
  quantity     numeric(7,2) not null check (quantity >= 0),
  note         text not null default '',
  entered_by   uuid not null references app_user (id),
  entered_at   timestamptz not null default now(),
  primary key (school_id, month, user_id, unit)
);
create trigger payroll_input_audit after insert or update or delete on payroll_input for each row execute function audit_row();

-- ── Leave and attendance ───────────────────────────────────────────────────────────────────
create table staff_leave_type (
  code              text primary key check (code ~ '^[A-Z]{2,8}$'),
  name              text not null,
  pay               text not null check (pay in ('FULL', 'HALF', 'NONE')),
  credit_teaching   numeric(5,1) not null default 0,             -- days credited each year (1 January)
  credit_other      numeric(5,1) not null default 0,
  max_balance       numeric(6,1),
  gender            text check (gender in ('F', 'M')),
  max_per_spell     numeric(6,1),
  nes_above_days    numeric(5,1),                                 -- longer spells also need NES
  ordinal           smallint not null
);
insert into staff_leave_type (code, name, pay, credit_teaching, credit_other, max_balance, gender, max_per_spell, nes_above_days, ordinal) values
  ('CL', 'Casual leave', 'FULL', 8, 8, 8, null, 5, null, 1),
  ('EL', 'Earned leave', 'FULL', 10, 30, 300, null, 180, 30, 2),
  ('HPL', 'Half-pay leave', 'HALF', 20, 20, null, null, null, 60, 3),
  ('ML', 'Maternity leave', 'FULL', 0, 0, null, 'F', 180, null, 4),
  ('PAT', 'Paternity leave', 'FULL', 0, 0, null, 'M', 15, null, 5),
  ('CCL', 'Child care leave', 'FULL', 0, 0, null, 'F', 120, 60, 6),
  ('EOL', 'Extraordinary leave (without pay)', 'NONE', 0, 0, null, null, null, 30, 7);

-- Every credit and every leave taken; the balance is the sum, never typed in.
create table staff_leave_ledger (
  id          bigserial primary key,
  user_id     uuid not null references app_user (id),
  leave_code  text not null references staff_leave_type (code),
  on_date     date not null,
  days        numeric(6,1) not null check (days <> 0),
  reason      text not null,
  request_id  uuid,
  entered_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now()
);
create index staff_leave_ledger_user on staff_leave_ledger (user_id, leave_code);
create trigger staff_leave_ledger_immutable before update or delete on staff_leave_ledger for each row execute function forbid_change();

create table staff_leave_request (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user (id),
  school_id   uuid not null references org_unit (id),
  leave_code  text not null references staff_leave_type (code),
  period      daterange not null check (not isempty(period)),
  days        numeric(6,1) not null check (days > 0),
  half_day    boolean not null default false,
  reason      text not null check (length(trim(reason)) > 2 and length(reason) <= 500),
  status      text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by  uuid references app_user (id),
  decided_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  check (decided_by is null or decided_by <> user_id),
  check (not half_day or days = 0.5)
);
create unique index staff_leave_no_overlap on staff_leave_request (user_id, lower(period)) where status in ('PENDING', 'APPROVED');
create trigger staff_leave_request_audit after insert or update on staff_leave_request for each row execute function audit_row();

-- Daily staff attendance (from a biometric device or marked at school). P present, A absent,
-- H half day, L on sanctioned leave, D on official duty. Absence without leave is loss of pay.
create table staff_attendance (
  user_id    uuid not null references app_user (id),
  on_date    date not null,
  status     text not null check (status in ('P', 'A', 'H', 'L', 'D')),
  source     text not null default 'MANUAL' check (source in ('MANUAL', 'DEVICE', 'LEAVE')),
  marked_by  uuid not null references app_user (id),
  marked_at  timestamptz not null default now(),
  primary key (user_id, on_date)
);
create trigger staff_attendance_audit after insert or update or delete on staff_attendance for each row execute function audit_row();

-- ── Loans and advances ─────────────────────────────────────────────────────────────────────
create table staff_loan (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references app_user (id),
  school_id         uuid not null references org_unit (id),
  kind              text not null check (kind in ('FESTIVAL', 'SALARY_ADVANCE', 'SOCIETY', 'OTHER')),
  principal_paise   bigint not null check (principal_paise > 0),
  instalment_paise  bigint not null check (instalment_paise > 0),
  first_month       date not null check (extract(day from first_month) = 1),
  note              text not null default '',
  status            text not null default 'PROPOSED' check (status in ('PROPOSED', 'SANCTIONED', 'REJECTED')),
  created_by        uuid not null references app_user (id),
  sanctioned_by     uuid references app_user (id),
  sanctioned_at     timestamptz,
  created_at        timestamptz not null default now(),
  check (sanctioned_by is null or sanctioned_by <> created_by),
  check ((status = 'PROPOSED') = (sanctioned_by is null)),
  check (instalment_paise <= principal_paise)
);
create function staff_loan_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'loans are kept' using errcode = 'check_violation'; end if;
  if old.status <> 'PROPOSED' then raise exception 'a sanctioned or rejected loan cannot change' using errcode = 'check_violation'; end if;
  if (new.principal_paise, new.instalment_paise, new.first_month, new.user_id) is distinct from (old.principal_paise, old.instalment_paise, old.first_month, old.user_id) then
    raise exception 'the amounts cannot change after the proposal' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger staff_loan_guard before update or delete on staff_loan for each row execute function staff_loan_guard();
create trigger staff_loan_audit after insert or update on staff_loan for each row execute function audit_row();

-- ── Payroll runs ───────────────────────────────────────────────────────────────────────────
create table payroll_run (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  month         date not null check (extract(day from month) = 1),
  kind          text not null check (kind in ('REGULAR', 'SUPPLEMENTARY', 'FINAL')),
  for_user      uuid references app_user (id),                    -- the person, for a final settlement
  status        text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'LOCKED', 'PAID')),
  title         text not null,
  prepared_by   uuid not null references app_user (id),
  submitted_at  timestamptz,
  approved_by   uuid references app_user (id),                    -- locks the run
  nes_approved_by uuid references app_user (id),                  -- final settlements also need NES
  locked_at     timestamptz,
  paid_at       timestamptz,
  bank_ref      text,
  bank_file_sha text,
  totals        jsonb not null default '{}',
  issues        jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  check (approved_by is null or approved_by <> prepared_by),
  check ((kind = 'FINAL') = (for_user is not null)),
  check (status not in ('LOCKED', 'PAID') or (approved_by is not null and locked_at is not null)),
  check ((status = 'PAID') = (paid_at is not null and bank_ref is not null))
);
create unique index payroll_one_regular on payroll_run (school_id, month) where kind = 'REGULAR';
create function payroll_run_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then raise exception 'only a draft run can be discarded' using errcode = 'check_violation'; end if;
    return old;
  end if;
  if old.status in ('LOCKED', 'PAID') and (new.totals, new.school_id, new.month, new.kind, new.approved_by) is distinct from (old.totals, old.school_id, old.month, old.kind, old.approved_by) then
    raise exception 'a locked payroll run cannot change; pay or recover differences in a supplementary run' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'DRAFT' and new.status = 'SUBMITTED') or (old.status = 'SUBMITTED' and new.status in ('DRAFT', 'LOCKED'))
    or (old.status = 'LOCKED' and new.status = 'PAID')) then
    raise exception 'a payroll run cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payroll_run_guard before update or delete on payroll_run for each row execute function payroll_run_guard();
create trigger payroll_run_audit after insert or update on payroll_run for each row execute function audit_row();

-- One slip per person per run, and the lines on it. Each line keeps how it was worked out.
create table payroll_slip (
  run_id          uuid not null references payroll_run (id),
  user_id         uuid not null references app_user (id),
  days_in_month   smallint not null,
  paid_days       numeric(5,1) not null,
  lop_days        numeric(5,1) not null default 0,
  gross_paise     bigint not null,
  deduction_paise bigint not null,
  net_paise       bigint not null,
  employer_paise  bigint not null default 0,
  bank_id         uuid references employee_bank (id),
  primary key (run_id, user_id)
);
create table payroll_line (
  id              bigserial primary key,
  run_id          uuid not null references payroll_run (id),
  user_id         uuid not null references app_user (id),
  code            text not null,
  name            text not null,
  kind            text not null check (kind in ('EARNING', 'DEDUCTION', 'EMPLOYER')),
  taxable         boolean not null default false,
  amount_paise    bigint not null,
  basis           text not null,                                    -- "DA 60% × Basic ₹44,900"
  inputs          jsonb not null default '{}',
  loan_id         uuid references staff_loan (id),
  for_month       date                                              -- arrears: the month they belong to
);
create index payroll_line_run on payroll_line (run_id, user_id);
create index payroll_line_loan on payroll_line (loan_id) where loan_id is not null;
create function payroll_child_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from payroll_run where id = coalesce(new.run_id, old.run_id);
  if st <> 'DRAFT' then raise exception 'payslips of a run that is % cannot change', lower(st) using errcode = 'check_violation'; end if;
  return coalesce(new, old);
end $$;
create trigger payroll_slip_guard before insert or update or delete on payroll_slip for each row execute function payroll_child_guard();
create trigger payroll_line_guard before insert or update or delete on payroll_line for each row execute function payroll_child_guard();

-- Statutory payments and returns: PF, ESI, professional tax, TDS, one per period.
create table statutory_challan (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  kind          text not null check (kind in ('PF', 'ESI', 'PT', 'TDS')),
  period        date not null,                                     -- month (or quarter start for TDS returns)
  amount_paise  bigint not null check (amount_paise >= 0),
  reference     text not null check (length(trim(reference)) > 3),
  paid_on       date not null,
  file_sha      text,
  recorded_by   uuid not null references app_user (id),
  recorded_at   timestamptz not null default now(),
  unique (school_id, kind, period)
);
create trigger statutory_challan_immutable before update or delete on statutory_challan for each row execute function forbid_change();

-- Income-tax regime and declarations for a financial year (from the staff app).
create table tax_declaration (
  user_id       uuid not null references app_user (id),
  fy            text not null check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  regime        text not null check (regime in ('NEW', 'OLD')),
  items         jsonb not null default '{}',                        -- old regime: {"80C": paise, "80D": paise, "HRA_EXEMPT": paise, ...}
  updated_at    timestamptz not null default now(),
  primary key (user_id, fy)
);
create trigger tax_declaration_audit after insert or update on tax_declaration for each row execute function audit_row();

alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE', 'TRANSFER', 'CHAT', 'PAY'));

-- The office superintendent (or clerk) keeps the service book: a duty the principal gives.
alter table duty drop constraint duty_code_check;
alter table duty add constraint duty_code_check check (code in ('TIMETABLE_COORDINATOR', 'EXAM_INCHARGE', 'ADMISSION_INCHARGE', 'WEBSITE_EDITOR',
  'ATTENDANCE_OFFICER', 'HOUSE_MASTER', 'TRANSPORT_INCHARGE', 'LIBRARIAN', 'COUNSELLOR', 'STAFF_RECORDS'));

-- Non-teaching staff (office, laboratory, support) sign in for their own payslips, leave and chat.
alter table app_user drop constraint app_user_role_check;
alter table app_user add constraint app_user_role_check check (role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF', 'PARENT'));
