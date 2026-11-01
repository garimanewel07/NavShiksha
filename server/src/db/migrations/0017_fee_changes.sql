-- Fee changes after the year has started, one-off charges, and refunds.
--
--  1. Arrears. A fee revision can take effect from a past date (decided in October, from
--     1 April). The difference on instalments already due or paid is billed as arrears with its
--     own due date (with the next instalment, on a chosen date, or spread over the remaining
--     instalments), so nothing becomes overdue the moment it is raised.
--  2. Additional charges: CBSE registration, trips, events. Compulsory for a group of classes,
--     or optional, where only children whose parents say yes are charged. Collections the school
--     passes on (CBSE, a trip operator) are held as liabilities and paid out, not booked as income.
--  3. Refunds of credit (a child withdrawn from a trip, a cancelled trip, a fee reduction), approved
--     before money leaves the bank.
--
-- Every demand line stays permanent. Money owed is grouped by "bill": an instalment (Q1…Q4), a
-- revision's arrears (REV2, or REV2-1, REV2-2 when spread), or a charge (C:<id>).

insert into ledger_account (code, name, type) values
  ('2300', 'CBSE fees collected, payable to CBSE', 'LIABILITY'),
  ('2310', 'Trip and event collections, payable', 'LIABILITY'),
  ('4150', 'Other charges', 'INCOME');

alter table fee_head add column kind text not null default 'PLAN' check (kind in ('PLAN', 'CHARGE'));
insert into fee_head (code, name, income_account, refundable, alloc_priority, kind) values
  ('CBSE', 'CBSE registration and examination fee', '2300', false, 5, 'CHARGE'),
  ('TRIP', 'Educational trip', '2310', true, 6, 'CHARGE'),
  ('EVENT', 'Event or activity', '2310', true, 7, 'CHARGE'),
  ('OTHER', 'Other charge', '4150', false, 8, 'CHARGE');

-- ── Arrears on fee revisions ──────────────────────────────────────────────────────────────
alter table fee_plan_version
  add column arrears_mode text not null default 'WITH_NEXT' check (arrears_mode in ('WITH_NEXT', 'ON_DATE', 'SPREAD')),
  add column arrears_due date,
  add check (arrears_mode <> 'ON_DATE' or arrears_due is not null);

-- A revision effective from the very first day of the version in force replaces it completely:
-- that version becomes SUPERSEDED (kept, with its demand lines) instead of being given an end date.
alter table fee_plan_version drop constraint fee_plan_version_status_check;
alter table fee_plan_version add constraint fee_plan_version_status_check check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED'));
create or replace function fee_version_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.status <> 'DRAFT' then
    raise exception 'published fee versions are permanent' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status = 'SUPERSEDED' then
    raise exception 'a superseded fee version cannot change' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status = 'PUBLISHED' and new.status = 'SUPERSEDED' then
    if (new.plan_id, new.version, new.valid, new.policy, new.approved_by, new.arrears_mode, new.arrears_due)
       is distinct from (old.plan_id, old.version, old.valid, old.policy, old.approved_by, old.arrears_mode, old.arrears_due) then
      raise exception 'a fee version can only be superseded as it is' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'PUBLISHED' and (
      (new.plan_id, new.version, new.status, lower(new.valid), new.policy, new.approved_by, new.arrears_mode, new.arrears_due)
      is distinct from (old.plan_id, old.version, old.status, lower(old.valid), old.policy, old.approved_by, old.arrears_mode, old.arrears_due)) then
    raise exception 'a published fee version can only be given an end date' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

-- ── Additional charges ────────────────────────────────────────────────────────────────────
create table fee_charge (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references org_unit (id),
  academic_year     text not null references academic_year (code),
  head_code         text not null references fee_head (code),
  title             text not null check (length(title) between 3 and 120),
  details           text not null default '',
  amount_paise      bigint not null check (amount_paise > 0),
  mode              text not null check (mode in ('COMPULSORY', 'OPTIONAL')),
  class_codes       text[] not null check (cardinality(class_codes) > 0),
  section_ids       uuid[],                         -- null: every section of those classes
  due_on            date not null,
  respond_by        date,                           -- optional charges: parents reply by this date
  capacity          int check (capacity > 0),       -- optional charges: seats (a bus, a venue)
  refundable_until  date,                           -- withdrawn by this date: money back
  in_charge_id      uuid references app_user (id),  -- the teacher running the trip or event
  status            text not null default 'DRAFT' check (status in ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
  created_by        uuid not null references app_user (id),
  approved_by       uuid references app_user (id),
  opened_at         timestamptz,
  closed_at         timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  check ((mode = 'OPTIONAL') = (respond_by is not null)),
  check (mode = 'OPTIONAL' or capacity is null),
  check (respond_by is null or respond_by <= due_on),
  check (approved_by is null or approved_by <> created_by),                 -- maker-checker
  check (status = 'DRAFT' or (status = 'CANCELLED' and opened_at is null) or (approved_by is not null and opened_at is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null))
);
create index fee_charge_school on fee_charge (school_id, academic_year);

create function fee_charge_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then raise exception 'a charge that has been opened cannot be deleted; cancel it' using errcode = 'check_violation'; end if;
    return old;
  end if;
  if old.status = 'CANCELLED' then raise exception 'this charge is cancelled' using errcode = 'check_violation'; end if;
  if old.status <> 'DRAFT' and (new.school_id, new.head_code, new.amount_paise, new.mode, new.class_codes, new.section_ids, new.created_by, new.approved_by, new.academic_year)
     is distinct from (old.school_id, old.head_code, old.amount_paise, old.mode, old.class_codes, old.section_ids, old.created_by, old.approved_by, old.academic_year) then
    raise exception 'the amount and who it applies to cannot change once a charge is open; cancel it and raise a new one' using errcode = 'check_violation';
  end if;
  if not ((old.status = new.status) or (old.status = 'DRAFT' and new.status in ('OPEN', 'CANCELLED'))
          or (old.status = 'OPEN' and new.status in ('CLOSED', 'CANCELLED')) or (old.status = 'CLOSED' and new.status in ('OPEN', 'CANCELLED'))) then
    raise exception 'a charge cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fee_charge_guard before update or delete on fee_charge for each row execute function fee_charge_guard();
create trigger fee_charge_audit after insert or update or delete on fee_charge for each row execute function audit_row();

-- One row per child the charge reaches. Status history is kept by the audit log.
--   AWAITING  optional charge, no reply yet          IN         charged (compulsory, or parent said yes)
--   DECLINED  parent said no                         WAITLIST   said yes, but every seat is taken
--   NO_REPLY  replies closed without an answer       WITHDRAWN  pulled out after saying yes
--   EXCUSED   principal waived it, with a reason     CANCELLED  the whole charge was cancelled
create table fee_charge_participant (
  charge_id     uuid not null references fee_charge (id),
  enrolment_id  uuid not null references enrolment (id),
  status        text not null check (status in ('AWAITING', 'IN', 'DECLINED', 'WAITLIST', 'NO_REPLY', 'WITHDRAWN', 'EXCUSED', 'CANCELLED')),
  replied_by    uuid references app_user (id),
  replied_at    timestamptz,
  note          text not null default '',
  primary key (charge_id, enrolment_id)
);
create function fee_participant_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'participants are kept; change their status instead' using errcode = 'check_violation'; end if;
  if new.charge_id <> old.charge_id or new.enrolment_id <> old.enrolment_id then
    raise exception 'a participant cannot be moved to another charge or child' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'AWAITING' and new.status in ('IN', 'DECLINED', 'WAITLIST', 'NO_REPLY', 'EXCUSED', 'CANCELLED'))
    or (old.status = 'DECLINED' and new.status in ('IN', 'WAITLIST', 'EXCUSED', 'CANCELLED'))
    or (old.status = 'NO_REPLY' and new.status in ('IN', 'WAITLIST', 'DECLINED', 'EXCUSED', 'CANCELLED'))
    or (old.status = 'WAITLIST' and new.status in ('IN', 'DECLINED', 'WITHDRAWN', 'EXCUSED', 'CANCELLED'))
    or (old.status = 'IN' and new.status in ('WITHDRAWN', 'EXCUSED', 'CANCELLED'))
    or (old.status = 'WITHDRAWN' and new.status in ('IN', 'WAITLIST', 'EXCUSED', 'CANCELLED'))) then
    raise exception 'a participant cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fee_participant_transition before update or delete on fee_charge_participant for each row execute function fee_participant_transition();
create trigger fee_participant_audit after insert or update on fee_charge_participant for each row execute function audit_row();

-- ── Demand lines: instalments, arrears and charges ────────────────────────────────────────
alter table fee_demand
  alter column plan_id drop not null,
  alter column installment_code drop not null,
  alter column version_id drop not null,
  add column charge_id uuid references fee_charge (id),
  add column bill_key text,
  add column due_on date;
alter table fee_demand add column bill text generated always as (coalesce(bill_key, installment_code)) stored;
alter table fee_demand drop constraint fee_demand_kind_check;
-- TRANSFER lines move a credit on one bill to dues on another (in pairs that add up to zero).
alter table fee_demand add constraint fee_demand_kind_check check (kind in ('REGULAR', 'DIFFERENCE', 'LATE_FEE', 'ADJUSTMENT', 'CHARGE', 'TRANSFER'));
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'fee_demand'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%concession_paise <= gross_paise%';
  execute format('alter table fee_demand drop constraint %I', c);
end $$;
alter table fee_demand add constraint fee_demand_amounts check (kind in ('DIFFERENCE', 'ADJUSTMENT', 'TRANSFER')
  or (gross_paise >= 0 and concession_paise >= 0 and concession_paise <= gross_paise));
alter table fee_demand add constraint fee_demand_source check (
  (charge_id is null and plan_id is not null and installment_code is not null and version_id is not null)
  or (charge_id is not null and plan_id is null and installment_code is null and version_id is null and bill_key is not null));
alter table fee_demand add constraint fee_demand_charge_kind check (kind <> 'CHARGE' or charge_id is not null);
alter table fee_demand add constraint fee_demand_plan_kind check (kind not in ('REGULAR', 'DIFFERENCE', 'LATE_FEE') or charge_id is null);
alter table fee_demand add constraint fee_demand_arrears_due check (bill_key is null or due_on is not null);
-- Arrears spread over several bills repeat the same instalment and head, so the bill joins the key.
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'fee_demand'::regclass and contype = 'u';
  execute format('alter table fee_demand drop constraint %I', c);
end $$;
create unique index fee_demand_line_once on fee_demand (enrolment_id, installment_code, head_code, kind, version_id, bill) where kind in ('REGULAR', 'DIFFERENCE', 'LATE_FEE');
create index fee_demand_bill on fee_demand (enrolment_id, bill, head_code);
create index fee_demand_charge on fee_demand (charge_id) where charge_id is not null;

-- ── Refunds ───────────────────────────────────────────────────────────────────────────────
create table fee_refund (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  enrolment_id  uuid not null references enrolment (id),
  student_id    uuid not null references student (id),
  bill          text not null,
  amount_paise  bigint not null check (amount_paise > 0),
  reason        text not null check (length(reason) >= 3),
  status        text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'PAID', 'REJECTED')),
  requested_by  uuid not null references app_user (id),
  requested_at  timestamptz not null default now(),
  method        text check (method in ('BANK_TRANSFER', 'CHEQUE', 'CASH')),
  reference     text,
  paid_by       uuid references app_user (id),
  paid_at       timestamptz,
  check ((status = 'PAID') = (paid_at is not null and method is not null and reference is not null))
);
create function fee_refund_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'refund records cannot be deleted' using errcode = 'check_violation'; end if;
  if (new.amount_paise, new.enrolment_id, new.bill, new.school_id) is distinct from (old.amount_paise, old.enrolment_id, old.bill, old.school_id) then
    raise exception 'a refund''s amount cannot change' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not ((old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED')) or (old.status = 'APPROVED' and new.status = 'PAID')) then
    raise exception 'a refund cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fee_refund_transition before update or delete on fee_refund for each row execute function fee_refund_transition();
create trigger fee_refund_audit after insert or update on fee_refund for each row execute function audit_row();

-- Money actually returned, against the demand lines it came from (written when the refund is paid).
create table fee_refund_line (
  id            bigserial primary key,
  refund_id     uuid not null references fee_refund (id),
  demand_id     uuid not null references fee_demand (id),
  amount_paise  bigint not null check (amount_paise > 0)
);
create trigger fee_refund_line_immutable before update or delete on fee_refund_line for each row execute function forbid_change();

-- Money paid out of collections held for others (CBSE, a trip operator).
create table fee_charge_payout (
  id            uuid primary key default gen_random_uuid(),
  charge_id     uuid not null references fee_charge (id),
  amount_paise  bigint not null check (amount_paise > 0),
  paid_on       date not null,
  payee         text not null,
  reference     text not null,
  recorded_by   uuid not null references app_user (id),
  created_at    timestamptz not null default now()
);
create trigger fee_charge_payout_immutable before update or delete on fee_charge_payout for each row execute function forbid_change();

-- ── What is owed, by bill and head ────────────────────────────────────────────────────────
-- Paid = allocations less refunds paid. Derived, never stored.
drop view fee_due;
create view fee_due as
select f.enrolment_id, f.bill, f.head_code,
       min(f.installment_code) as installment_code,
       (array_agg(f.charge_id) filter (where f.charge_id is not null))[1] as charge_id,
       (array_agg(f.version_id order by f.created_at desc) filter (where f.kind = 'DIFFERENCE'))[1] as revision_id,
       max(f.due_on) as due_on,
       sum(f.net_paise) as owed_paise,
       coalesce(sum(f.net_paise) filter (where f.kind = 'TRANSFER'), 0) as transfer_paise,
       coalesce((select sum(a.amount_paise) from payment_allocation a join fee_demand g on g.id = a.demand_id
                  where g.enrolment_id = f.enrolment_id and g.bill = f.bill and g.head_code = f.head_code), 0)
     - coalesce((select sum(r.amount_paise) from fee_refund_line r join fee_demand g on g.id = r.demand_id
                  where g.enrolment_id = f.enrolment_id and g.bill = f.bill and g.head_code = f.head_code), 0) as paid_paise
  from fee_demand f
 group by f.enrolment_id, f.bill, f.head_code;

-- Never collect more than is owed on a bill and head; never refund more than the credit on it.
create or replace function allocation_within_due() returns trigger language plpgsql as $$
declare d record; owed bigint; paid bigint;
begin
  select enrolment_id, bill, head_code into d from fee_demand where id = new.demand_id;
  select owed_paise, paid_paise into owed, paid from fee_due where enrolment_id = d.enrolment_id and bill = d.bill and head_code = d.head_code;
  if tg_table_name = 'payment_allocation' and paid > owed then
    raise exception 'allocation exceeds the amount owed for % % (owed %, allocated %)', d.bill, d.head_code, owed, paid using errcode = 'check_violation';
  end if;
  if tg_table_name = 'fee_refund_line' and paid < owed then
    raise exception 'refund exceeds the credit on % % (owed %, paid after refund %)', d.bill, d.head_code, owed, paid using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger refund_within_credit after insert on fee_refund_line
  deferrable initially deferred for each row execute function allocation_within_due();

-- A charged child owes exactly the charge; anyone else owes nothing, except a child withdrawn
-- after the refund date, who keeps the charge. Checked at commit, after all lines are written.
create function fee_participant_balanced() returns trigger language plpgsql as $$
declare amt bigint; net bigint; deadline date; st text;
begin
  select c.amount_paise, c.refundable_until into amt, deadline from fee_charge c where c.id = new.charge_id;
  select status into st from fee_charge_participant where charge_id = new.charge_id and enrolment_id = new.enrolment_id;
  select coalesce(sum(net_paise), 0) into net from fee_demand where charge_id = new.charge_id and enrolment_id = new.enrolment_id and kind in ('CHARGE', 'ADJUSTMENT');
  if (st = 'IN' and net <> amt) or (st = 'WITHDRAWN' and net not in (0, amt)) or (st not in ('IN', 'WITHDRAWN') and net <> 0) then
    raise exception 'charge lines for this child (%) do not match their status (%)', net, lower(st) using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger fee_participant_balanced after insert or update on fee_charge_participant
  deferrable initially deferred for each row execute function fee_participant_balanced();
