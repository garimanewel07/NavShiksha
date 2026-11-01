-- Double-entry ledger. Every journal balances (checked when the transaction commits), and
-- posted entries are permanent; corrections are reversing journals.

create table ledger_account (
  code  text primary key check (code ~ '^\d{4}$'),
  name  text not null,
  type  text not null check (type in ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'))
);
insert into ledger_account (code, name, type) values
  ('1150', 'Payment gateway clearing', 'ASSET'),
  ('1160', 'Cash in hand', 'ASSET'),
  ('1200', 'Fees receivable from students', 'ASSET'),
  ('2100', 'Fees received in advance', 'LIABILITY'),
  ('4100', 'Tuition fee', 'INCOME'),
  ('4110', 'Annual charges', 'INCOME'),
  ('4120', 'Computer fee', 'INCOME'),
  ('4130', 'Transport fee', 'INCOME'),
  ('4140', 'Admission fee', 'INCOME'),
  ('4190', 'Late fee', 'INCOME'),
  ('5100', 'Fee concessions allowed', 'EXPENSE');

create table journal (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  posted_on    date not null default current_date,
  narration    text not null,
  source_type  text not null,
  source_id    text not null,
  reversal_of  uuid references journal (id),
  created_at   timestamptz not null default now(),
  unique (source_type, source_id)                    -- one posting per business event, ever
);

create table journal_line (
  id            bigserial primary key,
  journal_id    uuid not null references journal (id),
  account_code  text not null references ledger_account (code),
  debit_paise   bigint not null default 0 check (debit_paise >= 0),
  credit_paise  bigint not null default 0 check (credit_paise >= 0),
  student_id    uuid references student (id),
  check ((debit_paise = 0) <> (credit_paise = 0))
);
create index journal_line_journal on journal_line (journal_id);
create index journal_line_student on journal_line (student_id) where student_id is not null;

create function check_journal_balanced() returns trigger language plpgsql as $$
declare jid uuid; d bigint; c bigint; n int;
begin
  if tg_table_name = 'journal' then jid := new.id; else jid := new.journal_id; end if;
  select coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0), count(*)
    into d, c, n from journal_line where journal_id = jid;
  if n < 2 or d <> c then
    raise exception 'journal % does not balance (debits %, credits %, lines %)', jid, d, c, n
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger journal_line_balanced after insert on journal_line
  deferrable initially deferred for each row execute function check_journal_balanced();
create constraint trigger journal_has_lines after insert on journal
  deferrable initially deferred for each row execute function check_journal_balanced();

create trigger journal_immutable before update or delete on journal for each row execute function forbid_change();
create trigger journal_line_immutable before update or delete on journal_line for each row execute function forbid_change();
