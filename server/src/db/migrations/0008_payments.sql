-- Payments: orders, gateway events (each processed once), payments, receipts, allocations.

create table payment_order (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references org_unit (id),
  student_id        uuid not null references student (id),
  guardian_id       uuid references guardian (id),
  amount_paise      bigint not null check (amount_paise > 0),
  method            text not null check (method in ('UPI', 'DEBIT_CARD', 'CREDIT_CARD', 'NET_BANKING', 'CASH', 'CHEQUE')),
  charge_paise      bigint not null default 0 check (charge_paise >= 0),
  status            text not null default 'CREATED' check (status in ('CREATED', 'CAPTURED', 'FAILED', 'EXPIRED')),
  gateway           text not null,
  gateway_order_id  text not null unique,
  idempotency_key   text not null unique,
  lines             jsonb not null,                -- [{ demand_id, amount_paise }] fixed when the order is created
  created_at        timestamptz not null default now(),
  version           int not null default 1,
  updated_at        timestamptz not null default now()
);
create function payment_order_transition() returns trigger language plpgsql as $$
begin
  if new.status <> old.status and old.status <> 'CREATED' then
    raise exception 'a % order cannot change status', lower(old.status) using errcode = 'check_violation';
  end if;
  if (new.amount_paise, new.lines, new.school_id, new.student_id) is distinct from (old.amount_paise, old.lines, old.school_id, old.student_id) then
    raise exception 'order amount and lines are fixed once created' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payment_order_transition before update on payment_order for each row execute function payment_order_transition();
create trigger payment_order_version before update on payment_order for each row execute function bump_version();
create trigger payment_order_audit after insert or update on payment_order for each row execute function audit_row();

-- Gateways retry webhooks. The event id makes each one count once.
create table gateway_event (
  event_id      text primary key,
  gateway       text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now()
);

create table receipt_counter (
  school_id  uuid not null references org_unit (id),
  fy         text not null,
  last_no    int not null default 0,
  primary key (school_id, fy)
);

create table payment (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null unique references payment_order (id),
  school_id           uuid not null references org_unit (id),
  student_id          uuid not null references student (id),
  gateway_payment_id  text not null unique,
  amount_paise        bigint not null check (amount_paise > 0),
  method              text not null,
  receipt_no          text not null unique,
  captured_at         timestamptz not null default now()
);
create trigger payment_immutable before update or delete on payment for each row execute function forbid_change();
create trigger payment_audit after insert on payment for each row execute function audit_row();

create table payment_allocation (
  id            bigserial primary key,
  payment_id    uuid not null references payment (id),
  demand_id     uuid not null references fee_demand (id),
  amount_paise  bigint not null check (amount_paise > 0),
  unique (payment_id, demand_id)
);
create trigger payment_allocation_immutable before update or delete on payment_allocation for each row execute function forbid_change();

-- Never collect more than is owed: for each instalment and head, money allocated can never
-- exceed the net of all its demand lines (regular + differences + adjustments).
create function allocation_within_due() returns trigger language plpgsql as $$
declare d record; owed bigint; paid bigint;
begin
  select enrolment_id, installment_code, head_code into d from fee_demand where id = new.demand_id;
  select coalesce(sum(net_paise), 0) into owed from fee_demand
   where enrolment_id = d.enrolment_id and installment_code = d.installment_code and head_code = d.head_code;
  select coalesce(sum(a.amount_paise), 0) into paid from payment_allocation a join fee_demand f on f.id = a.demand_id
   where f.enrolment_id = d.enrolment_id and f.installment_code = d.installment_code and f.head_code = d.head_code;
  if paid > owed then
    raise exception 'allocation exceeds the amount owed for % % (owed %, allocated %)', d.installment_code, d.head_code, owed, paid
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger allocation_within_due after insert on payment_allocation
  deferrable initially deferred for each row execute function allocation_within_due();

-- What each student owes, by instalment and head. Derived, never stored, so it cannot drift.
create view fee_due as
select f.enrolment_id, f.installment_code, f.head_code,
       sum(f.net_paise) as owed_paise,
       coalesce((select sum(a.amount_paise) from payment_allocation a join fee_demand g on g.id = a.demand_id
                  where g.enrolment_id = f.enrolment_id and g.installment_code = f.installment_code
                    and g.head_code = f.head_code), 0) as paid_paise
  from fee_demand f
 group by f.enrolment_id, f.installment_code, f.head_code;
