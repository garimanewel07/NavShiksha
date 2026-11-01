-- Moving to another Navy Children School or Navy Kindergarten is a request, not an order.
--
-- The parent (in the app) or the present school's office asks a school that teaches the child's
-- class. That school checks its seats and accepts the child into a section, puts the request on
-- its waiting list, or declines it. Only an accepted request can be completed, and it is completed
-- by the present school issuing the transfer certificate: the child then moves into the accepted
-- section the day after the leaving date, with every record.

create table transfer_request (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references student (id),
  from_enrolment   uuid not null references enrolment (id),
  from_school_id   uuid not null references org_unit (id),
  to_school_id     uuid not null references org_unit (id),
  class_code       text not null references class_level (code),
  joining_on       date not null,                       -- first day at the new school
  reason           text not null check (length(reason) between 3 and 300),
  requested_by     uuid not null references app_user (id),
  requested_as     text not null check (requested_as in ('PARENT', 'SCHOOL')),
  status           text not null default 'PENDING'
                   check (status in ('PENDING', 'WAITLISTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'COMPLETED')),
  section_id       uuid references section (id),        -- the seat the new school gave
  decided_by       uuid references app_user (id),
  decided_at       timestamptz,
  decision_note    text,
  certificate_id   uuid references certificate (id),    -- the TC that completed it
  new_enrolment_id uuid references enrolment (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  check (from_school_id <> to_school_id),
  check (status not in ('ACCEPTED', 'COMPLETED') or section_id is not null),
  check (status <> 'DECLINED' or decision_note is not null),
  check (status <> 'COMPLETED' or (certificate_id is not null and new_enrolment_id is not null))
);
-- One open request per child at a time.
create unique index transfer_request_open on transfer_request (student_id) where status in ('PENDING', 'WAITLISTED', 'ACCEPTED');
create index transfer_request_to on transfer_request (to_school_id, status);
create index transfer_request_from on transfer_request (from_school_id, status);

create function transfer_request_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'transfer requests are kept' using errcode = 'check_violation'; end if;
  if (new.student_id, new.from_enrolment, new.from_school_id, new.to_school_id, new.requested_by, new.created_at)
     is distinct from (old.student_id, old.from_enrolment, old.from_school_id, old.to_school_id, old.requested_by, old.created_at) then
    raise exception 'who is moving and between which schools cannot change; cancel and ask again' using errcode = 'check_violation';
  end if;
  if old.status in ('DECLINED', 'CANCELLED', 'COMPLETED') then
    raise exception 'this transfer request is closed' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not (
       (old.status = 'PENDING' and new.status in ('ACCEPTED', 'WAITLISTED', 'DECLINED', 'CANCELLED'))
    or (old.status = 'WAITLISTED' and new.status in ('ACCEPTED', 'DECLINED', 'CANCELLED'))
    or (old.status = 'ACCEPTED' and new.status in ('COMPLETED', 'CANCELLED'))) then
    raise exception 'a transfer request cannot go from % to %', lower(old.status), lower(new.status) using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger transfer_request_guard before update or delete on transfer_request for each row execute function transfer_request_guard();
create trigger transfer_request_version before update on transfer_request for each row execute function bump_version();
create trigger transfer_request_audit after insert or update on transfer_request for each row execute function audit_row();

alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE', 'TRANSFER', 'CHAT'));
