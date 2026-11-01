-- The message centre (email and SMS for every module), tickets for every user, and the support
-- desk: human and AI agents who see tickets only, never a school's records. Fixes they propose are
-- applied by the system only after the department that owns the data (or the developer) approves.

-- ── Roles that see no school data ──────────────────────────────────────────────────────────
-- SUPPORT (helpdesk), DEVELOPER and CANDIDATE (recruitment applicants) have no place in the NES tree:
-- with no scope they cannot reach any school, child or staff record.
alter table app_user drop constraint app_user_role_check;
alter table app_user add constraint app_user_role_check check (role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF', 'PARENT', 'SUPPORT', 'DEVELOPER', 'CANDIDATE'));
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'app_user'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%scope_path IS NOT NULL%' loop
    execute format('alter table app_user drop constraint %I', c);
  end loop;
end $$;
alter table app_user add constraint app_user_scope check (role in ('PARENT', 'SUPPORT', 'DEVELOPER', 'CANDIDATE') or scope_path is not null);
-- A candidate's sign-in points at their candidate record (made in the recruitment migration).
alter table app_user add column candidate_id uuid unique;
alter table app_user add constraint app_user_candidate check ((role = 'CANDIDATE') = (candidate_id is not null));
alter table app_user add constraint app_user_no_scope check (role not in ('SUPPORT', 'DEVELOPER', 'CANDIDATE') or scope_path is null);

-- ── Email and SMS ──────────────────────────────────────────────────────────────────────────
-- Every message is written here first and sent by the dispatcher (retried with back-off), so a
-- failed provider never loses a message and every message to a candidate or parent can be shown.
create table outbound_message (
  id              bigserial primary key,
  channel         text not null check (channel in ('EMAIL', 'SMS')),
  to_address      text not null,
  template_code   text not null,
  subject         text,
  body            text not null,
  context         text not null,                          -- RECRUITMENT, CWT, SUPPORT, ACCOUNT …
  ref_type        text,
  ref_id          text,
  school_id       uuid references org_unit (id),
  batch_id        uuid,
  status          text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED')),
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  provider        text,
  provider_ref    text,
  created_by      uuid references app_user (id),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index outbound_message_queue on outbound_message (next_attempt_at) where status = 'QUEUED';
create index outbound_message_ref on outbound_message (ref_type, ref_id);
create index outbound_message_batch on outbound_message (batch_id) where batch_id is not null;
create index outbound_message_to on outbound_message (to_address, created_at desc);

-- A bulk send: who chose it, for which filter, how many.
create table outbound_batch (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid references org_unit (id),
  context     text not null,
  label       text not null,
  filter      jsonb not null default '{}',
  total       int not null default 0,
  created_by  uuid not null references app_user (id),
  created_at  timestamptz not null default now()
);

-- ── Tickets ────────────────────────────────────────────────────────────────────────────────
create sequence ticket_seq start 1;
create table ticket (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique default ('TKT-' || lpad(nextval('ticket_seq')::text, 6, '0')),
  raised_by           uuid not null references app_user (id),
  school_id           uuid references org_unit (id),
  category            text not null check (category in ('PROBLEM', 'DATA', 'REQUEST', 'QUESTION', 'ACCESS')),
  module              text not null,
  title               text not null check (length(trim(title)) between 4 and 160),
  description         text not null check (length(description) <= 5000),
  page                text,
  redacted_title      text not null,                    -- what agents see: no names, phones, emails or numbers
  redacted_description text not null,
  severity            text not null default 'NORMAL' check (severity in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status              text not null default 'NEW' check (status in ('NEW', 'TRIAGED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'AWAITING_DEVELOPER', 'AWAITING_USER', 'RESOLVED', 'CLOSED', 'REJECTED')),
  assigned_agent_id   uuid,
  resolved_by_agent_id uuid,
  resolution          text,
  ai_summary          text,
  needs_developer     boolean not null default false,
  developer_decision  text check (developer_decision in ('APPROVED', 'DECLINED')),
  developer_note      text,
  developer_by        uuid references app_user (id),
  rating              smallint check (rating between 1 and 5),
  due_at              timestamptz not null,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index ticket_status on ticket (status, due_at);
create index ticket_raised on ticket (raised_by, created_at desc);
create index ticket_school on ticket (school_id, created_at desc);
create trigger ticket_audit after insert or update on ticket for each row execute function audit_row();

create table ticket_message (
  id             bigserial primary key,
  ticket_id      uuid not null references ticket (id),
  author_kind    text not null check (author_kind in ('USER', 'AGENT', 'STAFF', 'SYSTEM')),
  author_user_id uuid references app_user (id),
  agent_id       uuid,
  body           text not null check (length(body) between 1 and 5000),
  redacted_body  text not null,
  internal       boolean not null default false,       -- a note between agents and the desk, not shown to the user
  created_at     timestamptz not null default now()
);
create index ticket_message_ticket on ticket_message (ticket_id, id);
create trigger ticket_message_immutable before update or delete on ticket_message for each row execute function forbid_change();

-- A record the ticket is about ("report a problem with this record"). Agents see only the opaque
-- reference and the kind of record, never the record.
create table ticket_ref (
  ref          text primary key,
  ticket_id    uuid not null references ticket (id),
  entity_type  text not null check (entity_type in ('STUDENT', 'GUARDIAN', 'STAFF', 'PAYROLL_RUN', 'ROUTE', 'SCHOOL', 'VACANCY', 'APPLICATION')),
  entity_id    uuid not null,
  field        text,                                   -- what the user says is wrong ("dob")
  correct_value text,                                  -- and what it should be: never shown to agents
  created_at   timestamptz not null default now()
);
create index ticket_ref_ticket on ticket_ref (ticket_id);

-- ── Support agents and their access ────────────────────────────────────────────────────────
-- An agent is a person at the helpdesk, the developer, or an AI. It calls the agent API with a key
-- and signs every request with its secret (stored encrypted); each call is logged.
create table support_agent (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique check (length(trim(name)) > 1),
  kind          text not null check (kind in ('AI', 'HUMAN', 'DEVELOPER')),
  user_id       uuid references app_user (id),
  key_id        text not null unique,
  secret_cipher text not null,
  scopes        text[] not null default '{READ,REPLY,PROPOSE}',
  active        boolean not null default true,
  created_by    uuid not null references app_user (id),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create trigger support_agent_audit after insert or update on support_agent for each row execute function audit_row();
alter table ticket add constraint ticket_agent_fk foreign key (assigned_agent_id) references support_agent (id);
alter table ticket add constraint ticket_resolver_fk foreign key (resolved_by_agent_id) references support_agent (id);
alter table ticket_message add constraint ticket_message_agent_fk foreign key (agent_id) references support_agent (id);

create table agent_call (
  id        bigserial primary key,
  agent_id  uuid not null references support_agent (id),
  method    text not null,
  path      text not null,
  status    smallint not null,
  at        timestamptz not null default now()
);
create index agent_call_agent on agent_call (agent_id, at desc);
create table agent_nonce (
  agent_id   uuid not null references support_agent (id),
  signature  text not null,
  at         timestamptz not null default now(),
  primary key (agent_id, signature)
);

-- ── Fixes ──────────────────────────────────────────────────────────────────────────────────
-- What an agent proposes. The system applies it only after the department that owns the data
-- approves (a data correction, a repair, a setting); code changes and anything risky or doubtful
-- go to the developer first.
create sequence fix_seq start 1;
create table fix_proposal (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique default ('FIX-' || lpad(nextval('fix_seq')::text, 6, '0')),
  ticket_id       uuid not null references ticket (id),
  agent_id        uuid not null references support_agent (id),
  kind            text not null check (kind in ('DATA_CORRECTION', 'REPAIR', 'SETTING', 'CODE_CHANGE')),
  ref             text references ticket_ref (ref),
  field           text,
  new_value       text,
  action          text,
  params          jsonb not null default '{}',
  summary         text not null check (length(trim(summary)) > 4),
  details         text not null default '',
  risk            text not null default 'LOW' check (risk in ('LOW', 'MEDIUM', 'HIGH')),
  school_id       uuid references org_unit (id),
  status          text not null default 'PROPOSED' check (status in ('DEVELOPER_REVIEW', 'PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED')),
  developer_by    uuid references app_user (id),
  developer_at    timestamptz,
  developer_note  text,
  decided_by      uuid references app_user (id),
  decided_at      timestamptz,
  decision_note   text,
  applied_at      timestamptz,
  result          text,
  created_at      timestamptz not null default now(),
  check (kind <> 'DATA_CORRECTION' or (ref is not null and field is not null and new_value is not null)),
  check (kind <> 'REPAIR' or action is not null),
  check (kind <> 'SETTING' or (field is not null and new_value is not null))
);
create index fix_open on fix_proposal (status) where status in ('DEVELOPER_REVIEW', 'PROPOSED');
create trigger fix_proposal_audit after insert or update on fix_proposal for each row execute function audit_row();
create function fix_proposal_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'fix proposals are kept' using errcode = 'check_violation'; end if;
  if (new.kind, new.ref, new.field, new.new_value, new.action, new.params, new.summary, new.details, new.ticket_id, new.agent_id)
     is distinct from (old.kind, old.ref, old.field, old.new_value, old.action, old.params, old.summary, old.details, old.ticket_id, old.agent_id) then
    raise exception 'a fix proposal cannot be changed; propose a new one' using errcode = 'check_violation';
  end if;
  if old.status in ('APPLIED', 'REJECTED', 'FAILED') and new.status <> old.status then
    raise exception 'this fix is already %', lower(old.status) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fix_proposal_guard before update or delete on fix_proposal for each row execute function fix_proposal_guard();

alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE', 'TRANSFER', 'CHAT', 'PAY', 'TRANSPORT', 'SUPPORT', 'RECRUITMENT'));
