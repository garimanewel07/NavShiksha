-- Printing and the records printed from it: photos, staff details, printers and their
-- calibration, label sheets, the library (catalogue, copies with accession numbers, loans,
-- fines), ID card designs, and certificates (TC, bonafide, character, study, fee paid, CEA).
--
-- Everything printable is drawn as a PDF in exact millimetres. Each school records its printers
-- with an offset and scale measured from a calibration page, so labels, cards and certificates
-- land where they should on that school's own printer and stationery.

-- ── Photos and staff details ──────────────────────────────────────────────────────────────
create table person_photo (
  owner_kind    text not null check (owner_kind in ('STUDENT', 'STAFF')),
  owner_id      uuid not null,
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  data          bytea not null check (octet_length(data) <= 1048576),
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now(),
  primary key (owner_kind, owner_id)
);
create trigger person_photo_audit after insert or update or delete on person_photo for each row execute function audit_row();

create table staff_profile (
  user_id            uuid primary key references app_user (id),
  school_id          uuid not null references org_unit (id),
  employee_no        text not null check (length(employee_no) between 1 and 20),
  blood_group        text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  phone              text check (phone ~ '^\+91[6-9][0-9]{9}$'),
  dob                date,
  joined_on          date,
  emergency_contact  text,
  version            int not null default 1,
  updated_at         timestamptz not null default now(),
  unique (school_id, employee_no)
);
create trigger staff_profile_version before update on staff_profile for each row execute function bump_version();
create trigger staff_profile_audit after insert or update on staff_profile for each row execute function audit_row();

-- Images used on prints: the school's logo, the principal's signature, the school stamp.
create table print_asset (
  school_id     uuid not null references org_unit (id),
  kind          text not null check (kind in ('LOGO', 'SIGNATURE', 'STAMP')),
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  data          bytea not null check (octet_length(data) <= 1048576),
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now(),
  primary key (school_id, kind)
);
create trigger print_asset_audit after insert or update or delete on print_asset for each row execute function audit_row();

-- ── Printers and stationery ───────────────────────────────────────────────────────────────
-- Offsets move everything printed by that many millimetres (right and down are positive);
-- scale corrects printers that shrink or stretch the page slightly.
create table printer_profile (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  name         text not null check (length(name) between 2 and 60),
  purpose      text not null check (purpose in ('LABELS', 'CARDS', 'DOCUMENTS')),
  offset_x_mm  numeric(4, 1) not null default 0 check (offset_x_mm between -25 and 25),
  offset_y_mm  numeric(4, 1) not null default 0 check (offset_y_mm between -25 and 25),
  scale_pct    numeric(5, 2) not null default 100 check (scale_pct between 90 and 110),
  notes        text not null default '',
  active       boolean not null default true,
  version      int not null default 1,
  updated_at   timestamptz not null default now(),
  unique (school_id, name)
);
create trigger printer_profile_version before update on printer_profile for each row execute function bump_version();
create trigger printer_profile_audit after insert or update on printer_profile for each row execute function audit_row();

-- Label stationery: common A4 sheets (shared by all schools) and roll labels, plus any a school adds.
create table label_sheet (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid references org_unit (id),                   -- null: available to every school
  name       text not null,
  page_w     numeric(5, 1) not null check (page_w > 0),
  page_h     numeric(5, 1) not null check (page_h > 0),
  cols       int not null check (cols between 1 and 10),
  rows       int not null check (rows between 1 and 30),
  label_w    numeric(5, 1) not null check (label_w > 0),
  label_h    numeric(5, 1) not null check (label_h > 0),
  margin_left numeric(5, 1) not null default 0,
  margin_top  numeric(5, 1) not null default 0,
  gap_x      numeric(4, 1) not null default 0,
  gap_y      numeric(4, 1) not null default 0,
  check (margin_left + cols * label_w + (cols - 1) * gap_x <= page_w + 0.5),
  check (margin_top + rows * label_h + (rows - 1) * gap_y <= page_h + 0.5)
);
create unique index label_sheet_name on label_sheet (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
insert into label_sheet (name, page_w, page_h, cols, rows, label_w, label_h, margin_left, margin_top, gap_x, gap_y) values
  ('A4, 65 labels (38.1 × 21.2 mm, Avery L7651 type)', 210, 297, 5, 13, 38.1, 21.2, 4.7, 10.7, 2.5, 0),
  ('A4, 40 labels (45.7 × 25.4 mm, Avery L7654 type)', 210, 297, 4, 10, 45.7, 25.4, 9.7, 21.5, 2.6, 0),
  ('A4, 24 labels (63.5 × 33.9 mm, Avery L7159 type)', 210, 297, 3, 8, 63.5, 33.9, 7.2, 12.9, 2.5, 0),
  ('A4, 21 labels (63.5 × 38.1 mm, Avery L7160 type)', 210, 297, 3, 7, 63.5, 38.1, 7.2, 15.1, 2.5, 0),
  ('Roll label 50 × 25 mm (thermal printer)', 50, 25, 1, 1, 50, 25, 0, 0, 0, 0),
  ('Roll label 38 × 25 mm (thermal printer)', 38, 25, 1, 1, 38, 25, 0, 0, 0, 0);

-- ── Library ───────────────────────────────────────────────────────────────────────────────
create table library_book (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  title         text not null check (length(trim(title)) > 0),
  author        text not null default '',
  publisher     text not null default '',
  edition       text not null default '',
  year          int check (year between 1800 and 2100),
  isbn          text check (isbn ~ '^[0-9]{9}[0-9X]$|^[0-9]{13}$'),
  subject       text not null default '',
  language      text not null default 'English',
  call_number   text not null default '',
  price_paise   bigint not null default 0 check (price_paise >= 0),
  created_at    timestamptz not null default now(),
  version       int not null default 1,
  updated_at    timestamptz not null default now()
);
create index library_book_school on library_book (school_id);
create trigger library_book_version before update on library_book for each row execute function bump_version();
create trigger library_book_audit after insert or update on library_book for each row execute function audit_row();

-- Each physical copy has an accession number from the school's accession register, never reused,
-- and a code its label carries. New copies get a barcode made from the accession number; copies
-- brought over from the old ERP keep the code already on their label (barcode or QR text), so
-- nothing has to be relabelled.
create table library_counter (
  school_id  uuid primary key references org_unit (id),
  last_no    int not null default 0
);
create table library_copy (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references library_book (id),
  school_id     uuid not null references org_unit (id),
  accession_no  int not null check (accession_no > 0),
  barcode       text not null check (length(barcode) between 1 and 200),
  status        text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'ON_LOAN', 'LOST', 'DAMAGED', 'WITHDRAWN')),
  acquired_on   date not null default current_date,
  source        text not null default 'PURCHASE' check (source in ('PURCHASE', 'DONATION', 'OTHER')),
  location      text not null default '',
  label_printed_at timestamptz,
  imported      boolean not null default false,          -- came from the old ERP with its own label
  version       int not null default 1,
  updated_at    timestamptz not null default now(),
  unique (school_id, accession_no),
  unique (school_id, barcode)
);
create trigger library_copy_version before update on library_copy for each row execute function bump_version();
create trigger library_copy_audit after insert or update on library_copy for each row execute function audit_row();
create function library_copy_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'a copy stays in the accession register; mark it withdrawn instead' using errcode = 'check_violation'; end if;
  if (new.accession_no, new.barcode, new.school_id) is distinct from (old.accession_no, old.barcode, old.school_id) then
    raise exception 'an accession number and barcode never change' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger library_copy_guard before update or delete on library_copy for each row execute function library_copy_guard();

create table library_loan (
  id             uuid primary key default gen_random_uuid(),
  copy_id        uuid not null references library_copy (id),
  school_id      uuid not null references org_unit (id),
  enrolment_id   uuid references enrolment (id),
  user_id        uuid references app_user (id),
  issued_on      date not null default current_date,
  due_on         date not null,
  returned_on    date,
  renewals       int not null default 0 check (renewals >= 0),
  fine_paise     bigint not null default 0 check (fine_paise >= 0),
  fine_note      text not null default '',
  issued_by      uuid not null references app_user (id),
  returned_by    uuid references app_user (id),
  lost           boolean not null default false,
  check ((enrolment_id is null) <> (user_id is null)),
  check (due_on >= issued_on),
  check (returned_on is null or returned_on >= issued_on)
);
-- A copy is with one borrower at a time.
create unique index library_loan_open on library_loan (copy_id) where returned_on is null;
create index library_loan_enrolment on library_loan (enrolment_id) where enrolment_id is not null;
create index library_loan_user on library_loan (user_id) where user_id is not null;
create function library_loan_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'loans are kept' using errcode = 'check_violation'; end if;
  if old.returned_on is not null then raise exception 'this loan is closed' using errcode = 'check_violation'; end if;
  if (new.copy_id, new.enrolment_id, new.user_id, new.issued_on, new.issued_by) is distinct from (old.copy_id, old.enrolment_id, old.user_id, old.issued_on, old.issued_by) then
    raise exception 'who borrowed which copy, and when, cannot change' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger library_loan_guard before update or delete on library_loan for each row execute function library_loan_guard();
create trigger library_loan_audit after insert or update on library_loan for each row execute function audit_row();

-- Library fines are billed through fees, so parents pay them like any other bill.
insert into ledger_account (code, name, type) values ('4160', 'Library fines and lost books', 'INCOME');
insert into fee_head (code, name, income_account, refundable, alloc_priority, kind) values ('LIBRARY', 'Library fine or lost book', '4160', false, 10, 'CHARGE');
alter table fee_demand drop constraint fee_demand_kind_check;
alter table fee_demand add constraint fee_demand_kind_check check (kind in ('REGULAR', 'DIFFERENCE', 'LATE_FEE', 'ADJUSTMENT', 'CHARGE', 'TRANSFER', 'FINE'));
alter table fee_demand drop constraint fee_demand_source;
alter table fee_demand add constraint fee_demand_source check (
  (charge_id is null and kind <> 'FINE' and plan_id is not null and installment_code is not null and version_id is not null)
  or (charge_id is not null and plan_id is null and installment_code is null and version_id is null and bill_key is not null)
  or (charge_id is null and plan_id is null and installment_code is null and version_id is null and bill_key like 'LIB:%' and kind in ('FINE', 'ADJUSTMENT', 'TRANSFER')));
-- Waived fines are reversed by an ADJUSTMENT with the same bill; transfers are already allowed.
alter table fee_demand drop constraint fee_demand_amounts;
alter table fee_demand add constraint fee_demand_amounts check (kind in ('DIFFERENCE', 'ADJUSTMENT', 'TRANSFER')
  or (gross_paise >= 0 and concession_paise >= 0 and concession_paise <= gross_paise));

-- ── ID card designs ───────────────────────────────────────────────────────────────────────
create table card_design (
  school_id   uuid not null references org_unit (id),
  kind        text not null check (kind in ('STUDENT', 'STAFF')),
  design      jsonb not null,
  updated_by  uuid not null references app_user (id),
  version     int not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (school_id, kind)
);
create trigger card_design_version before update on card_design for each row execute function bump_version();
create trigger card_design_audit after insert or update on card_design for each row execute function audit_row();

-- Which cards each person has for each academic year. New admissions and new staff during the
-- year show up as "no card yet"; at the change of year everyone needs a new card.
create table card_issue (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  kind           text not null check (kind in ('STUDENT', 'STAFF')),
  owner_id       uuid not null,
  academic_year  text not null references academic_year (code),
  reprint        boolean not null default false,
  printed_by     uuid not null references app_user (id),
  printed_at     timestamptz not null default now()
);
create index card_issue_owner on card_issue (kind, owner_id, academic_year);
create trigger card_issue_immutable before update or delete on card_issue for each row execute function forbid_change();

-- What was printed, by whom, on which printer: for reprints and lost cards.
create table print_log (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references org_unit (id),
  kind        text not null check (kind in ('STUDENT_CARD', 'STAFF_CARD', 'BOOK_LABEL', 'CERTIFICATE', 'CALIBRATION')),
  items       int not null check (items >= 0),
  detail      jsonb not null default '{}',
  printer_id  uuid references printer_profile (id),
  printed_by  uuid not null references app_user (id),
  printed_at  timestamptz not null default now()
);
create trigger print_log_immutable before update or delete on print_log for each row execute function forbid_change();

-- ── Certificates ──────────────────────────────────────────────────────────────────────────
-- What certificates print in the school heading, and class roll numbers (the CEA certificate
-- asks for them).
alter table org_unit add column school_no text, add column website text, add column phone text, add column email text, add column city text,
  add column board text not null default 'Central Board of Secondary Education (CBSE)';
alter table enrolment add column roll_no int check (roll_no between 1 and 200);
create unique index enrolment_roll_no on enrolment (section_id, roll_no) where roll_no is not null and status in ('ACTIVE', 'PROVISIONAL');

create table certificate_counter (
  school_id  uuid not null references org_unit (id),
  kind       text not null,
  year       text not null,
  last_no    int not null default 0,
  primary key (school_id, kind, year)
);
create table certificate (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  kind            text not null check (kind in ('TC', 'BONAFIDE', 'CHARACTER', 'STUDY', 'FEE_PAID', 'CEA')),
  student_id      uuid not null references student (id),
  enrolment_id    uuid not null references enrolment (id),
  purpose         text not null default '',
  data            jsonb not null,                              -- every printed field, fixed at issue
  status          text not null default 'DRAFT' check (status in ('REQUESTED', 'DRAFT', 'PENDING', 'ISSUED', 'REJECTED', 'CANCELLED')),
  serial_no       text,                                        -- per school register: CEA/2026-27/0001
  verify_code     text unique check (verify_code ~ '^[A-Z0-9]{10}$'),
  requested_by    uuid not null references app_user (id),
  prepared_by     uuid references app_user (id),
  issued_by       uuid references app_user (id),
  issued_on       date,
  cancel_reason   text,
  copies_printed  int not null default 0,
  created_at      timestamptz not null default now(),
  version         int not null default 1,
  updated_at      timestamptz not null default now(),
  check ((status in ('ISSUED', 'CANCELLED')) = (serial_no is not null and verify_code is not null and issued_on is not null)),
  check ((status = 'CANCELLED') = (cancel_reason is not null)),
  unique (school_id, serial_no)
);
create index certificate_school on certificate (school_id, status);
create index certificate_student on certificate (student_id);
create function certificate_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('ISSUED', 'CANCELLED') then raise exception 'an issued certificate is kept in the register' using errcode = 'check_violation'; end if;
    return old;
  end if;
  if old.status in ('ISSUED', 'CANCELLED') then
    if (new.data, new.serial_no, new.verify_code, new.kind, new.student_id, new.enrolment_id, new.issued_by, new.issued_on)
       is distinct from (old.data, old.serial_no, old.verify_code, old.kind, old.student_id, old.enrolment_id, old.issued_by, old.issued_on) then
      raise exception 'an issued certificate cannot be changed; cancel it and issue a new one' using errcode = 'check_violation';
    end if;
    if old.status = 'CANCELLED' and new.status <> 'CANCELLED' then raise exception 'a cancelled certificate stays cancelled' using errcode = 'check_violation'; end if;
  end if;
  if new.status <> old.status and not (
       (old.status = 'REQUESTED' and new.status in ('DRAFT', 'REJECTED'))
    or (old.status = 'DRAFT' and new.status in ('PENDING', 'REJECTED'))
    or (old.status = 'PENDING' and new.status in ('ISSUED', 'DRAFT', 'REJECTED'))
    or (old.status = 'ISSUED' and new.status = 'CANCELLED')) then
    raise exception 'a certificate cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger certificate_guard before update or delete on certificate for each row execute function certificate_guard();
create trigger certificate_version before update on certificate for each row execute function bump_version();
create trigger certificate_audit after insert or update on certificate for each row execute function audit_row();
-- Only one transfer certificate in force per enrolment.
create unique index certificate_one_tc on certificate (enrolment_id) where kind = 'TC' and status not in ('REJECTED', 'CANCELLED');

-- A child who has left can still have a certificate issued for their last enrolment.
alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE'));
