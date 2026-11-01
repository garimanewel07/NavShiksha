-- Accounts: bank statements matched to the books, and the entries only the bank statement tells
-- the school about (gateway settlements, bank charges, interest, cash deposited). Each school keeps
-- its own books; NES sees them added up, never pooled.

insert into ledger_account (code, name, type) values
  ('4900', 'Bank interest', 'INCOME'),
  ('5900', 'Bank and payment gateway charges', 'EXPENSE')
on conflict do nothing;

-- A statement as the bank sent it. The same file cannot be imported twice.
create table bank_statement (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  bank_label    text not null check (length(trim(bank_label)) > 1),
  period        daterange not null check (not isempty(period)),
  file_sha      text not null,
  lines         int not null,
  imported_by   uuid not null references app_user (id),
  imported_at   timestamptz not null default now(),
  unique (school_id, file_sha)
);
create trigger bank_statement_immutable before update or delete on bank_statement for each row execute function forbid_change();

-- Each line of the statement: money in is positive, money out negative. A line seen in two
-- overlapping statements is kept once.
create table bank_line (
  id             uuid primary key default gen_random_uuid(),
  statement_id   uuid not null references bank_statement (id),
  school_id      uuid not null references org_unit (id),
  on_date        date not null,
  narration      text not null,
  reference      text not null default '',
  amount_paise   bigint not null check (amount_paise <> 0),
  balance_paise  bigint,
  seq            int not null default 0,                 -- order in the bank's file (several lines share a date)
  status         text not null default 'UNMATCHED' check (status in ('UNMATCHED', 'MATCHED', 'POSTED', 'IGNORED')),
  journal_id     uuid references journal (id),
  how            text,                                   -- AUTO, MANUAL, GATEWAY, CHARGES, INTEREST, CASH_DEPOSIT
  note           text,
  decided_by     uuid references app_user (id),
  decided_at     timestamptz,
  check ((status in ('MATCHED', 'POSTED')) = (journal_id is not null)),
  check (status <> 'IGNORED' or length(trim(note)) > 3)
);
create unique index bank_line_once on bank_line (school_id, on_date, amount_paise, reference, md5(narration));
create unique index bank_line_journal on bank_line (journal_id) where journal_id is not null;   -- one bank line per book entry
create index bank_line_open on bank_line (school_id, status);
create trigger bank_line_audit after insert or update on bank_line for each row execute function audit_row();

create function bank_line_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'bank statement lines are kept' using errcode = 'check_violation'; end if;
  if (new.on_date, new.amount_paise, new.narration, new.reference, new.school_id, new.statement_id) is distinct from (old.on_date, old.amount_paise, old.narration, old.reference, old.school_id, old.statement_id) then
    raise exception 'a bank statement line cannot be changed' using errcode = 'check_violation';
  end if;
  if old.status = 'POSTED' and new.status <> 'POSTED' then raise exception 'an entry posted from the statement stays; reverse it with a new entry' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger bank_line_guard before update or delete on bank_line for each row execute function bank_line_guard();

-- Who may see the books and who keeps them.
-- (Permissions are in code: accounts.view, accounts.reconcile.)

-- The school's tax deduction account number, for TDS challans, the quarterly return and Form 16.
alter table org_unit add column tan text check (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$');
