-- Admissions: applications, documents, decisions. Admission creates the student and enrolment
-- in one transaction, so an admitted application always has a student and vice versa.

create sequence application_seq start 1001;

create table application (
  id                    uuid primary key default gen_random_uuid(),
  ref_no                text not null unique default ('APP-' || nextval('application_seq')),
  school_id             uuid not null references org_unit (id),
  campus_id             uuid not null references org_unit (id),
  academic_year         text not null references academic_year (code),
  class_code            text not null references class_level (code),
  child_name            text not null check (length(trim(child_name)) > 1),
  child_dob             date not null,
  child_gender          text not null check (child_gender in ('F', 'M', 'X')),
  guardian_id           uuid not null references guardian (id),
  relationship          text not null check (relationship in ('FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT')),
  status                text not null default 'SUBMITTED' check (status in
                          ('SUBMITTED', 'VERIFIED', 'OFFERED', 'ADMITTED', 'PROVISIONAL', 'WAITLISTED', 'REJECTED', 'WITHDRAWN')),
  admission_category    text not null,
  category_priority     int not null,
  fee_band              text not null,
  category_explanation  jsonb not null,
  over_capacity_reason  text,
  decision_note         text,
  student_id            uuid references student (id),
  submitted_at          timestamptz not null default now(),
  decided_at            timestamptz,
  version               int not null default 1,
  updated_at            timestamptz not null default now(),
  check ((status in ('ADMITTED', 'PROVISIONAL')) = (student_id is not null)),
  check (status not in ('REJECTED') or decision_note is not null)
);
create index application_school_status on application (school_id, status);

-- Allowed status moves. Anything else is refused by the database, whatever the client sends.
create function application_transition() returns trigger language plpgsql as $$
declare ok boolean;
begin
  if new.status = old.status then return new; end if;
  ok := (old.status, new.status) in (
    ('SUBMITTED', 'VERIFIED'), ('SUBMITTED', 'REJECTED'), ('SUBMITTED', 'WITHDRAWN'), ('SUBMITTED', 'WAITLISTED'),
    ('VERIFIED', 'OFFERED'), ('VERIFIED', 'WAITLISTED'), ('VERIFIED', 'REJECTED'), ('VERIFIED', 'WITHDRAWN'),
    ('WAITLISTED', 'OFFERED'), ('WAITLISTED', 'WITHDRAWN'), ('WAITLISTED', 'REJECTED'),
    ('OFFERED', 'ADMITTED'), ('OFFERED', 'PROVISIONAL'), ('OFFERED', 'WITHDRAWN'),
    ('PROVISIONAL', 'ADMITTED'));
  if not ok then
    raise exception 'an application cannot move from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  new.decided_at := now();
  return new;
end $$;
create trigger application_transition before update of status on application for each row execute function application_transition();
create trigger application_version before update on application for each row execute function bump_version();
create trigger application_audit after insert or update or delete on application for each row execute function audit_row();

create table application_document (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references application (id),
  doc_type        text not null check (doc_type in ('BIRTH_CERTIFICATE', 'FORM_2A', 'POSTING_ORDER', 'ESM_CARD',
                    'PPO', 'TRANSFER_CERTIFICATE', 'ADDRESS_PROOF', 'STAFF_ID')),
  status          text not null default 'PENDING' check (status in ('PENDING', 'VERIFIED', 'REJECTED')),
  note            text,
  verified_by     text,
  verified_at     timestamptz,
  unique (application_id, doc_type),
  check (status <> 'REJECTED' or note is not null)
);
create trigger application_document_audit after insert or update on application_document for each row execute function audit_row();
