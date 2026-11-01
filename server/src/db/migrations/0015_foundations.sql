-- Foundations every module uses: settings inherited NES → Command → school, duties, approval
-- chains and attachments. Additive only.

-- ── Settings ───────────────────────────────────────────────────────────────────────────────
-- One value per unit, key and date. A school uses the nearest value above it (its own, then its
-- Command's, then NES's), unless a unit above has locked the key, in which case that value wins.
-- Which keys exist and what values they accept is defined in code (lib/settingsRegistry.ts).
create table setting_value (
  id        bigserial primary key,
  unit_id   uuid not null references org_unit (id),
  key       text not null check (key ~ '^[a-z][a-z0-9_.]{2,60}$'),
  value     jsonb not null,
  locked    boolean not null default false,
  valid     daterange not null check (not isempty(valid)),
  note      text not null default '',
  set_by    uuid not null references app_user (id),
  set_at    timestamptz not null default now(),
  exclude using gist (unit_id with =, key with =, valid with &&)
);
create index setting_value_key on setting_value (key, unit_id);
-- A value is never edited: a change is a new value from a date, which closes the old one.
create function setting_close_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if lower(old.valid) >= current_date then return old; end if;
    raise exception 'settings in force cannot be deleted; set a new value from a date' using errcode = 'check_violation';
  end if;
  if new.unit_id <> old.unit_id or new.key <> old.key or new.value <> old.value or new.locked <> old.locked or lower(new.valid) <> lower(old.valid) then
    raise exception 'a setting cannot be edited; set a new value from a date' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger setting_close_only before update or delete on setting_value for each row execute function setting_close_only();
create trigger setting_audit after insert or update or delete on setting_value for each row execute function audit_row();

-- ── Duties ─────────────────────────────────────────────────────────────────────────────────
-- Extra responsibilities a staff member holds at a school for a period, beyond their role.
create table duty (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references org_unit (id),
  user_id      uuid not null references app_user (id),
  code         text not null check (code in ('TIMETABLE_COORDINATOR', 'EXAM_INCHARGE', 'ADMISSION_INCHARGE', 'WEBSITE_EDITOR',
                                             'ATTENDANCE_OFFICER', 'HOUSE_MASTER', 'TRANSPORT_INCHARGE', 'LIBRARIAN', 'COUNSELLOR')),
  valid        daterange not null check (not isempty(valid)),
  assigned_by  uuid not null references app_user (id),
  assigned_at  timestamptz not null default now(),
  exclude using gist (school_id with =, user_id with =, code with =, valid with &&)
);
create function duty_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from org_unit where id = new.school_id and kind = 'school') then
    raise exception 'duties belong to a school' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from app_user u join org_unit o on o.id = new.school_id where u.id = new.user_id and u.role <> 'PARENT' and u.scope_path <@ o.path) then
    raise exception 'duties can only be given to staff of that school' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.code <> old.code or new.school_id <> old.school_id or lower(new.valid) <> lower(old.valid)) then
    raise exception 'a duty cannot be edited; end it and assign a new one' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger duty_check before insert or update on duty for each row execute function duty_check();
create trigger duty_no_delete before delete on duty for each row execute function forbid_change();
create trigger duty_audit after insert or update on duty for each row execute function audit_row();

-- ── Approval chains ────────────────────────────────────────────────────────────────────────
-- A request moves through the steps that applied when it was raised (kept with the request, so a
-- later change to the chain never affects requests already in progress).
create table approval_request (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  kind          text not null check (kind ~ '^[a-z_]{3,40}$'),
  ref_id        uuid not null,
  title         text not null,
  summary       text not null default '',
  steps         jsonb not null check (jsonb_typeof(steps) = 'array'),
  payload       jsonb not null default '{}',
  current_step  int not null default 1,
  status        text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by  uuid not null references app_user (id),
  requested_at  timestamptz not null default now(),
  closed_at     timestamptz,
  unique (kind, ref_id),
  check ((status = 'PENDING') = (closed_at is null))
);
create index approval_open on approval_request (school_id) where status = 'PENDING';
create function approval_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'approval records cannot be deleted' using errcode = 'check_violation'; end if;
  if old.status <> 'PENDING' then raise exception 'this request is already closed' using errcode = 'check_violation'; end if;
  if new.steps <> old.steps or new.kind <> old.kind or new.ref_id <> old.ref_id or new.school_id <> old.school_id then
    raise exception 'a request''s steps cannot be changed' using errcode = 'check_violation';
  end if;
  if new.current_step < old.current_step then raise exception 'a request cannot go back a step' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger approval_transition before update or delete on approval_request for each row execute function approval_transition();
create trigger approval_audit after insert or update on approval_request for each row execute function audit_row();

create table approval_decision (
  request_id  uuid not null references approval_request (id),
  step_no     int not null,
  decision    text not null check (decision in ('APPROVE', 'REJECT')),
  decided_by  uuid not null references app_user (id),
  note        text not null default '',
  decided_at  timestamptz not null default now(),
  primary key (request_id, step_no)
);
-- Nobody approves their own request, and nobody decides two steps of the same request.
create function approval_decision_check() returns trigger language plpgsql as $$
begin
  if exists (select 1 from approval_request where id = new.request_id and requested_by = new.decided_by) then
    raise exception 'you cannot approve your own request' using errcode = 'check_violation';
  end if;
  if exists (select 1 from approval_decision where request_id = new.request_id and decided_by = new.decided_by) then
    raise exception 'one person can decide only one step of a request' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger approval_decision_check before insert on approval_decision for each row execute function approval_decision_check();
create trigger approval_decision_immutable before update or delete on approval_decision for each row execute function forbid_change();

-- ── Attachments ────────────────────────────────────────────────────────────────────────────
-- Files attached to records. Access always follows the record they belong to.
create table attachment (
  id            uuid primary key default gen_random_uuid(),
  ref_kind      text not null check (ref_kind in ('homework', 'notice', 'leave', 'student')),
  ref_id        uuid not null,
  name          text not null check (length(name) between 1 and 160),
  content_type  text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  bytes         bytea not null check (octet_length(bytes) between 1 and 5242880),
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now(),
  removed_at    timestamptz
);
create index attachment_ref on attachment (ref_kind, ref_id) where removed_at is null;
create trigger attachment_guard before update or delete on attachment for each row execute function only_changes('removed_at');
create trigger attachment_audit after insert or update on attachment for each row execute function audit_row();

-- ── Attendance corrections ─────────────────────────────────────────────────────────────────
-- Past attendance stays locked in the database. The application may open it only inside a
-- transaction that has checked the school's correction window or an approved correction, by
-- setting app.attendance_correction for that transaction alone.
create or replace function attendance_lock() returns trigger language plpgsql as $$
declare d date;
begin
  select on_date into d from attendance_session where id = coalesce(new.session_id, old.session_id);
  if d < current_date and coalesce(current_setting('app.attendance_correction', true), '') <> 'allowed' then
    raise exception 'attendance for % is locked' , d using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
