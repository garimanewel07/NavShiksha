-- Emergency controls (kill switches) for NES, and a record of every unexpected server error so
-- the helpdesk can find it from the reference shown to the user. Additive only.

-- Each switch is off unless a row says it is on. Nothing is ever deleted by a switch: it only
-- stops new work (sign-ins, changes, payments, messages, public pages) until it is turned off.
create table system_switch (
  key        text primary key check (key in ('MAINTENANCE', 'READ_ONLY', 'PAYMENTS_OFF', 'PUBLIC_OFF', 'SIGN_IN_OFF', 'MESSAGES_OFF')),
  is_on      boolean not null default false,
  reason     text not null default '',
  set_by     uuid references app_user (id),
  set_at     timestamptz not null default now()
);
create table system_switch_event (
  id         bigserial primary key,
  key        text not null,
  is_on      boolean not null,
  reason     text not null,
  set_by     uuid references app_user (id),
  at         timestamptz not null default now()
);
create trigger system_switch_event_immutable before update or delete on system_switch_event for each row execute function forbid_change();

create table error_log (
  ref        text primary key,
  at         timestamptz not null default now(),
  method     text not null,
  path       text not null,
  status     int not null,
  message    text not null,
  stack      text,
  user_id    uuid
);
create index error_log_at on error_log (at desc);
