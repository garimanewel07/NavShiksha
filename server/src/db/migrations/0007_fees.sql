-- Fees: heads, plans with dated versions, rates, instalments, concessions, and an append-only
-- list of demands. A demand is never edited: a fee revision adds DIFFERENCE lines, a waiver adds
-- an ADJUSTMENT line, so every rupee owed can be traced to the rule and version that created it.

create table fee_head (
  code            text primary key,
  name            text not null,
  income_account  text not null references ledger_account (code),
  refundable      boolean not null default false,
  alloc_priority  int not null unique
);
insert into fee_head (code, name, income_account, refundable, alloc_priority) values
  ('TUITION', 'Tuition fee', '4100', false, 1),
  ('ANNUAL', 'Annual charges', '4110', false, 2),
  ('COMPUTER', 'Computer fee', '4120', false, 3),
  ('TRANSPORT', 'Transport fee', '4130', false, 4),
  ('LATE', 'Late fee', '4190', false, 9);

create table fee_plan (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  academic_year  text not null references academic_year (code),
  name           text not null,
  unique (school_id, academic_year)
);

create table fee_installment (
  plan_id   uuid not null references fee_plan (id),
  code      text not null check (code ~ '^Q[1-4]$'),
  label     text not null,
  due_date  date not null,
  period    daterange not null check (not isempty(period)),
  primary key (plan_id, code),
  exclude using gist (plan_id with =, period with &&)
);

create table fee_plan_version (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references fee_plan (id),
  version       int not null check (version > 0),
  valid         daterange not null check (not isempty(valid)),
  status        text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED')),
  policy        text not null default 'FUTURE_ONLY' check (policy in ('FUTURE_ONLY', 'DIFFERENCE_ON_PAID')),
  note          text,
  created_by    text not null default app_actor(),
  approved_by   text,
  published_at  timestamptz,
  unique (plan_id, version),
  exclude using gist (plan_id with =, valid with &&) where (status = 'PUBLISHED'),
  check (status = 'DRAFT' or (approved_by is not null and published_at is not null)),
  check (approved_by is null or approved_by <> created_by)            -- maker-checker
);

create table fee_rate (
  version_id    uuid not null references fee_plan_version (id),
  class_band    text not null check (class_band in ('PRE', 'PRIMARY', 'MIDDLE', 'SECONDARY', 'SENIOR')),
  fee_band      text not null,
  head_code     text not null references fee_head (code),
  periodicity   text not null check (periodicity in ('QUARTERLY', 'ANNUAL')),
  amount_paise  bigint not null check (amount_paise >= 0),
  primary key (version_id, class_band, fee_band, head_code)
);

-- A published version and its rates are frozen; the only change allowed is ending its validity
-- when the next version takes over.
create function fee_version_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.status = 'PUBLISHED' then
    raise exception 'published fee versions are permanent' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status = 'PUBLISHED' and (
      (new.plan_id, new.version, new.status, lower(new.valid), new.policy, new.approved_by)
      is distinct from (old.plan_id, old.version, old.status, lower(old.valid), old.policy, old.approved_by)) then
    raise exception 'a published fee version can only be given an end date' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger fee_version_guard before update or delete on fee_plan_version for each row execute function fee_version_guard();
create trigger fee_version_audit after insert or update or delete on fee_plan_version for each row execute function audit_row();

create function fee_rate_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from fee_plan_version where id = coalesce(new.version_id, old.version_id) and status = 'PUBLISHED') then
    raise exception 'rates of a published fee version cannot change' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger fee_rate_guard before insert or update or delete on fee_rate for each row execute function fee_rate_guard();

create table concession_rule (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid references org_unit (id),          -- null: applies across NES
  name        text not null,
  condition   jsonb not null,
  head_code   text not null references fee_head (code),
  percent     numeric(5, 2) not null check (percent > 0 and percent <= 100),
  priority    int not null,
  valid       daterange not null check (not isempty(valid))
);

create table fee_demand (
  id                uuid primary key default gen_random_uuid(),
  enrolment_id      uuid not null references enrolment (id),
  plan_id           uuid not null references fee_plan (id),
  installment_code  text not null,
  head_code         text not null references fee_head (code),
  version_id        uuid not null references fee_plan_version (id),
  kind              text not null check (kind in ('REGULAR', 'DIFFERENCE', 'LATE_FEE', 'ADJUSTMENT')),
  gross_paise       bigint not null,
  concession_paise  bigint not null default 0,
  net_paise         bigint generated always as (gross_paise - concession_paise) stored,
  fee_band          text not null,
  snapshot          jsonb not null,
  created_at        timestamptz not null default now(),
  foreign key (plan_id, installment_code) references fee_installment (plan_id, code),
  check (kind in ('DIFFERENCE', 'ADJUSTMENT')
         or (gross_paise >= 0 and concession_paise >= 0 and concession_paise <= gross_paise)),
  unique (enrolment_id, installment_code, head_code, kind, version_id)
);
-- A student is charged a regular line for an instalment and head exactly once, however often
-- the generation job runs.
create unique index fee_demand_regular_once on fee_demand (enrolment_id, installment_code, head_code) where kind = 'REGULAR';
create index fee_demand_enrolment on fee_demand (enrolment_id);
create trigger fee_demand_immutable before update or delete on fee_demand for each row execute function forbid_change();
