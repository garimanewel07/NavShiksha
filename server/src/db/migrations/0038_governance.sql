-- R6: NES governance (committees, agenda, meetings, minutes, decisions with live progress, the
-- NES Conference, voting by circulation, action-taken reports from schools), school inspections
-- with checklists, and the daily sign-in record behind the ERP adoption figures. Additive only.

-- ── Committees ───────────────────────────────────────────────────────────────────────────────
-- A committee belongs to a level of the NES tree (NES, a Command or a school). A working group is a
-- committee formed for one topic with a deadline; the NES Conference is a committee whose meetings
-- are its sessions, whose members are the delegates and whose decisions are its resolutions.
create table committee (
  id            uuid primary key default gen_random_uuid(),
  unit_id       uuid not null references org_unit (id),
  kind          text not null check (kind in ('EXECUTIVE', 'MANAGEMENT_ADVISORY', 'ACADEMIC_ADVISORY', 'SCHOOL_MANAGING', 'ACADEMIC_MONITORING',
                                              'PURCHASE', 'CHILD_PROTECTION', 'SAFETY', 'WORKING_GROUP', 'CONFERENCE', 'OTHER')),
  name          text not null check (length(trim(name)) between 3 and 120),
  purpose       text not null default '',                   -- terms of reference, or the working group's topic
  quorum        smallint not null default 3 check (quorum between 1 and 100),
  ends_on       date,                                        -- a working group's deadline, a conference's last day
  confidential  boolean not null default false,              -- everything members-only (for example child protection)
  active        boolean not null default true,
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  version       int not null default 1,
  updated_at timestamptz not null default now()
);
create index committee_unit on committee (unit_id);
create trigger committee_version before update on committee for each row execute function bump_version();
create trigger committee_audit after insert or update on committee for each row execute function audit_row();

-- Members are NavShiksha users (their name and post come from their record) or people outside it,
-- such as a parent representative or a nominee of the station, kept by name.
create table committee_member (
  id               uuid primary key default gen_random_uuid(),
  committee_id     uuid not null references committee (id),
  user_id          uuid references app_user (id),
  external_name    text,
  external_detail  text not null default '',                -- designation or organisation
  external_email   text,
  role             text not null check (role in ('CHAIR', 'CONVENER', 'MEMBER', 'INVITEE')),
  valid            daterange not null default daterange(current_date, null),
  added_by         uuid not null references app_user (id),
  added_at         timestamptz not null default now(),
  check ((user_id is null) <> (external_name is null)),
  check (external_name is null or length(trim(external_name)) > 1),
  exclude using gist (committee_id with =, role with =, valid with &&) where (role in ('CHAIR', 'CONVENER')),
  exclude using gist (committee_id with =, user_id with =, valid with &&) where (user_id is not null)
);
create index committee_member_user on committee_member (user_id) where user_id is not null;
create trigger committee_member_guard before update or delete on committee_member for each row execute function only_changes('valid');
create trigger committee_member_audit after insert or update on committee_member for each row execute function audit_row();

-- ── Meetings ─────────────────────────────────────────────────────────────────────────────────
create table meeting (
  id               uuid primary key default gen_random_uuid(),
  committee_id     uuid not null references committee (id),
  number           int not null check (number > 0),         -- the committee's 1st, 2nd… meeting
  title            text not null check (length(trim(title)) > 2),
  kind             text not null default 'ORDINARY' check (kind in ('ORDINARY', 'SPECIAL', 'SESSION')),
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  venue            text not null default '',
  video_link       text not null default '' check (video_link = '' or video_link ~ '^https://'),
  agenda_closes    timestamptz not null,
  status           text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'HELD', 'CANCELLED')),
  cancel_reason    text,
  quorum_met       boolean,
  minutes_status   text not null default 'NONE' check (minutes_status in ('NONE', 'DRAFT', 'CIRCULATED', 'CONFIRMED')),
  minutes_note     text not null default '',                 -- opening remarks and anything not under an item
  circulated_at    timestamptz,
  confirmed_by     uuid references app_user (id),
  confirmed_at     timestamptz,
  reminded_at      timestamptz,
  created_by       uuid not null references app_user (id),
  created_at       timestamptz not null default now(),
  version          int not null default 1,
  updated_at timestamptz not null default now(),
  unique (committee_id, number),
  check (agenda_closes <= starts_at),
  check (ends_at is null or ends_at > starts_at),
  check (status <> 'CANCELLED' or cancel_reason is not null),
  check ((minutes_status = 'CONFIRMED') = (confirmed_at is not null)),
  check (minutes_status = 'NONE' or status = 'HELD')
);
create index meeting_committee on meeting (committee_id, starts_at);
create trigger meeting_version before update on meeting for each row execute function bump_version();
create trigger meeting_audit after insert or update on meeting for each row execute function audit_row();

-- Confirmed minutes are the record: nothing in the meeting changes after that.
create function meeting_lock() returns trigger language plpgsql as $$
begin
  if old.minutes_status = 'CONFIRMED' and (new.minutes_note is distinct from old.minutes_note or new.status is distinct from old.status
      or new.minutes_status is distinct from old.minutes_status or new.starts_at is distinct from old.starts_at or new.title is distinct from old.title) then
    raise exception 'The minutes of this meeting are confirmed and cannot be changed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger meeting_lock before update on meeting for each row execute function meeting_lock();

create table meeting_attendance (
  meeting_id   uuid not null references meeting (id),
  member_id    uuid not null references committee_member (id),
  status       text not null check (status in ('PRESENT', 'ABSENT', 'LEAVE')),
  primary key (meeting_id, member_id)
);
create trigger meeting_attendance_audit after insert or update or delete on meeting_attendance for each row execute function audit_row();

-- ── Agenda ───────────────────────────────────────────────────────────────────────────────────
-- Members (and, for the conference, every principal) submit items before the cut-off; the convener
-- accepts them onto a meeting, defers, merges or rejects them. The discussion is the item's minutes.
create table agenda_item (
  id              uuid primary key default gen_random_uuid(),
  committee_id    uuid not null references committee (id),
  meeting_id      uuid references meeting (id),
  position        int,
  title           text not null check (length(trim(title)) between 3 and 200),
  details         text not null default '',
  raised_by       uuid not null references app_user (id),
  for_unit        uuid references org_unit (id),            -- the school that raised it (conference topics)
  confidential    boolean not null default false,
  status          text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'ACCEPTED', 'DEFERRED', 'MERGED', 'REJECTED')),
  merged_into     uuid references agenda_item (id),
  triage_note     text,
  discussion      text not null default '',
  from_decision   uuid,                                      -- carried forward from a decision that needs another meeting
  created_at      timestamptz not null default now(),
  version         int not null default 1,
  updated_at timestamptz not null default now(),
  check (status <> 'MERGED' or merged_into is not null),
  check (status <> 'REJECTED' or triage_note is not null)
);
create index agenda_item_meeting on agenda_item (meeting_id);
create index agenda_item_committee on agenda_item (committee_id, status);
create trigger agenda_item_version before update on agenda_item for each row execute function bump_version();
create trigger agenda_item_audit after insert or update on agenda_item for each row execute function audit_row();

create table minutes_comment (
  id          bigserial primary key,
  meeting_id  uuid not null references meeting (id),
  user_id     uuid not null references app_user (id),
  body        text not null check (length(trim(body)) between 2 and 2000),
  at          timestamptz not null default now()
);
create trigger minutes_comment_immutable before update or delete on minutes_comment for each row execute function forbid_change();

-- ── Decisions ────────────────────────────────────────────────────────────────────────────────
-- A decision is taken in a meeting (it is PROPOSED until the minutes are confirmed, then takes its
-- recorded outcome) or by circulation (members vote; a majority with a quorum of votes adopts it).
create table decision (
  id                 uuid primary key default gen_random_uuid(),
  committee_id       uuid not null references committee (id),
  meeting_id         uuid references meeting (id),
  agenda_item_id     uuid references agenda_item (id),
  ref                text not null unique,                    -- EC/2026-27/04
  title              text not null check (length(trim(title)) between 3 and 200),
  body               text not null check (length(trim(body)) > 4),
  reason             text not null default '',
  outcome            text not null default 'DECIDED' check (outcome in ('DECIDED', 'DEFERRED', 'NEEDS_MEETING')),
  status             text not null default 'PROPOSED' check (status in ('PROPOSED', 'DECIDED', 'IN_PROGRESS', 'IMPLEMENTED', 'CLOSED', 'DEFERRED', 'NEEDS_MEETING', 'NOT_ADOPTED')),
  owner_id           uuid references app_user (id),
  due_on             date,
  confidential       boolean not null default false,
  by_circulation     boolean not null default false,
  circulation_closes date,
  created_by         uuid not null references app_user (id),
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  closed_at          timestamptz,
  version            int not null default 1,
  updated_at timestamptz not null default now(),
  check (by_circulation = (circulation_closes is not null)),
  check (by_circulation or meeting_id is not null),
  check (status not in ('DECIDED', 'IN_PROGRESS', 'IMPLEMENTED', 'CLOSED') or decided_at is not null),
  check ((status = 'CLOSED') = (closed_at is not null))
);
create index decision_committee on decision (committee_id, status);
create index decision_owner on decision (owner_id) where owner_id is not null;
create index decision_search on decision using gin (to_tsvector('english', title || ' ' || body || ' ' || reason));
create trigger decision_version before update on decision for each row execute function bump_version();
create trigger decision_audit after insert or update on decision for each row execute function audit_row();
alter table agenda_item add constraint agenda_item_from_decision foreign key (from_decision) references decision (id);

create table decision_event (
  id           bigserial primary key,
  decision_id  uuid not null references decision (id),
  from_status  text,
  to_status    text not null,
  note         text not null default '',
  by_user      uuid references app_user (id),
  at           timestamptz not null default now()
);
create index decision_event_d on decision_event (decision_id);
create trigger decision_event_immutable before update or delete on decision_event for each row execute function forbid_change();

-- The schools a decision reaches: each acknowledges it and reports the action taken.
create table decision_school (
  decision_id      uuid not null references decision (id),
  school_id        uuid not null references org_unit (id),
  notice_id        uuid references notice (id),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references app_user (id),
  report           text,
  reported_at      timestamptz,
  reported_by      uuid references app_user (id),
  primary key (decision_id, school_id),
  check ((report is null) = (reported_at is null)),
  check (reported_at is null or acknowledged_at is not null)
);
create trigger decision_school_audit after insert or update on decision_school for each row execute function audit_row();

create table decision_vote (
  decision_id  uuid not null references decision (id),
  member_id    uuid not null references committee_member (id),
  vote         text not null check (vote in ('YES', 'NO', 'ABSTAIN')),
  note         text not null default '',
  at           timestamptz not null default now(),
  primary key (decision_id, member_id)
);
create trigger decision_vote_immutable before update or delete on decision_vote for each row execute function forbid_change();

create table decision_action (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid not null references decision (id),
  title          text not null check (length(trim(title)) between 3 and 200),
  owner_id       uuid not null references app_user (id),
  due_on         date not null,
  percent        smallint not null default 0 check (percent between 0 and 100),
  status         text not null default 'OPEN' check (status in ('OPEN', 'DONE', 'DROPPED')),
  reminded_on    date,
  created_by     uuid not null references app_user (id),
  created_at     timestamptz not null default now(),
  version        int not null default 1,
  updated_at timestamptz not null default now(),
  check (status <> 'DONE' or percent = 100)
);
create index decision_action_owner on decision_action (owner_id, status);
create index decision_action_d on decision_action (decision_id);
create trigger decision_action_version before update on decision_action for each row execute function bump_version();
create trigger decision_action_audit after insert or update on decision_action for each row execute function audit_row();

create table action_update (
  id          bigserial primary key,
  action_id   uuid not null references decision_action (id),
  by_user     uuid not null references app_user (id),
  percent     smallint not null check (percent between 0 and 100),
  note        text not null check (length(trim(note)) > 1),
  at          timestamptz not null default now()
);
create index action_update_a on action_update (action_id);
create trigger action_update_immutable before update or delete on action_update for each row execute function forbid_change();

-- ── Inspections ──────────────────────────────────────────────────────────────────────────────
-- NES keeps the checklists. Each inspection keeps a copy of the checklist as it was when it was
-- planned, so changing a checklist later never changes a report already made.
create table inspection_template (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references org_unit (id),
  name        text not null check (length(trim(name)) between 3 and 120),
  purpose     text not null default '',
  scale       smallint not null default 4 check (scale in (3, 4, 5)),
  sections    jsonb not null check (jsonb_typeof(sections) = 'array' and jsonb_array_length(sections) > 0),
  active      boolean not null default true,
  created_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now(),
  version     int not null default 1,
  updated_at timestamptz not null default now()
);
create trigger inspection_template_version before update on inspection_template for each row execute function bump_version();
create trigger inspection_template_audit after insert or update on inspection_template for each row execute function audit_row();

create table inspection (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  template_id   uuid not null references inspection_template (id),
  checklist     jsonb not null,                              -- {scale, sections} copied when planned
  kind          text not null check (kind in ('ANNUAL', 'SURPRISE', 'THEMATIC', 'SELF')),
  title         text not null check (length(trim(title)) > 2),
  scheduled_on  date not null,
  status        text not null default 'PLANNED' check (status in ('PLANNED', 'IN_PROGRESS', 'REPORTED', 'CLOSED', 'CANCELLED')),
  lead_id       uuid not null references app_user (id),
  summary       text not null default '',
  score         numeric(5,1) check (score between 0 and 100),
  started_at    timestamptz,
  reported_at   timestamptz,
  closed_at     timestamptz,
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  version       int not null default 1,
  updated_at timestamptz not null default now(),
  check (status not in ('REPORTED', 'CLOSED') or (reported_at is not null and score is not null))
);
create index inspection_school on inspection (school_id, scheduled_on);
create trigger inspection_version before update on inspection for each row execute function bump_version();
create trigger inspection_audit after insert or update on inspection for each row execute function audit_row();

create table inspection_team (
  inspection_id  uuid not null references inspection (id),
  user_id        uuid not null references app_user (id),
  primary key (inspection_id, user_id)
);
create trigger inspection_team_audit after insert or delete on inspection_team for each row execute function audit_row();

create table inspection_rating (
  inspection_id  uuid not null references inspection (id),
  item_id        text not null,
  rating         smallint check (rating between 1 and 5),
  not_applicable boolean not null default false,
  remark         text not null default '',
  rated_by       uuid not null references app_user (id),
  rated_at       timestamptz not null default now(),
  primary key (inspection_id, item_id),
  check (not (not_applicable and rating is not null))
);
create trigger inspection_rating_audit after insert or update on inspection_rating for each row execute function audit_row();

create table inspection_finding (
  id             uuid primary key default gen_random_uuid(),
  inspection_id  uuid not null references inspection (id),
  item_id        text,
  severity       text not null check (severity in ('ADVISORY', 'MINOR', 'MAJOR', 'CRITICAL')),
  body           text not null check (length(trim(body)) > 4),
  due_on         date,
  status         text not null default 'OPEN' check (status in ('OPEN', 'RESPONDED', 'CLOSED')),
  response       text,
  responded_by   uuid references app_user (id),
  responded_at   timestamptz,
  closed_by      uuid references app_user (id),
  closed_at      timestamptz,
  created_by     uuid not null references app_user (id),
  created_at     timestamptz not null default now(),
  version        int not null default 1,
  updated_at timestamptz not null default now(),
  check (status = 'OPEN' or response is not null or status = 'CLOSED'),
  check ((status = 'CLOSED') = (closed_at is not null))
);
create index inspection_finding_i on inspection_finding (inspection_id);
create trigger inspection_finding_version before update on inspection_finding for each row execute function bump_version();
create trigger inspection_finding_audit after insert or update on inspection_finding for each row execute function audit_row();

-- ── Adoption ─────────────────────────────────────────────────────────────────────────────────
-- One row per person per day they signed in: enough for "staff using NavShiksha" without tracking clicks.
create table sign_in_day (
  user_id  uuid not null references app_user (id),
  on_date  date not null,
  primary key (user_id, on_date)
);

-- Meeting papers, evidence for actions and inspections are ordinary attachments.
alter table attachment drop constraint attachment_ref_kind_check;
alter table attachment add constraint attachment_ref_kind_check check (ref_kind in ('homework', 'notice', 'leave', 'student', 'meeting', 'action', 'inspection'));
