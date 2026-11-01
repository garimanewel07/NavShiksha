-- School transport, each school's own. A child's stop is entered once (on their allocation) and
-- from it follow the transport fee, the bus list, the boarding register and the parent app's
-- "My bus". Tracking is by the timetable of stop times (no GPS needed): the attendant may tap
-- "started", "at this stop" or "running late", and parents further along see revised times.
-- GPS can be switched on for a route when a device is fitted.

-- Vehicles, with the documents that must be in force.
create table vehicle (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  reg_no          text not null unique check (reg_no ~ '^[A-Z]{2}[ -]?[0-9]{1,2}[ -]?[A-Z]{0,3}[ -]?[0-9]{1,4}$'),
  kind            text not null check (kind in ('BUS', 'MINIBUS', 'VAN')),
  seats           smallint not null check (seats between 4 and 80),
  owner           text not null default 'SCHOOL' check (owner in ('SCHOOL', 'CONTRACTOR', 'NAVY')),
  contractor      text,
  fitness_until   date,
  insurance_until date,
  permit_until    date,
  puc_until       date,
  gps_device      text,                                  -- when a tracker is fitted (GPS mode)
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check (owner <> 'CONTRACTOR' or length(trim(contractor)) > 1)
);
create trigger vehicle_audit after insert or update on vehicle for each row execute function audit_row();

-- Drivers and attendants: a member of the school's staff (their details come from the staff
-- record), or the contractor's person (name and phone kept here).
create table transport_crew (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null references org_unit (id),
  user_id          uuid references app_user (id),
  name             text,
  phone            text check (phone ~ '^\+91[6-9][0-9]{9}$'),
  role             text not null check (role in ('DRIVER', 'ATTENDANT')),
  licence_no       text,
  licence_until    date,
  police_verified_on date,
  active           boolean not null default true,
  check ((user_id is null) = (name is not null)),
  check (role <> 'DRIVER' or licence_no is not null)
);
create unique index transport_crew_user on transport_crew (school_id, user_id, role) where user_id is not null;
create trigger transport_crew_audit after insert or update on transport_crew for each row execute function audit_row();

-- Fare zones, priced a month at a time, from a date.
create table transport_fare (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references org_unit (id),
  zone           text not null check (zone ~ '^[A-Z0-9]{1,6}$'),
  name           text not null,
  monthly_paise  bigint not null check (monthly_paise >= 0),
  valid          daterange not null check (not isempty(valid)),
  created_by     uuid not null references app_user (id),
  exclude using gist (school_id with =, zone with =, valid with &&)
);
create trigger transport_fare_audit after insert or update on transport_fare for each row execute function audit_row();

create table route (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references org_unit (id),
  code          text not null check (code ~ '^[A-Z0-9-]{1,10}$'),
  name          text not null,
  vehicle_id    uuid references vehicle (id),
  driver_id     uuid references transport_crew (id),
  attendant_id  uuid references transport_crew (id),
  tracking      text not null default 'TIMETABLE' check (tracking in ('TIMETABLE', 'GPS')),
  active        boolean not null default true,
  unique (school_id, code)
);
create trigger route_audit after insert or update on route for each row execute function audit_row();

-- Stops in order, with the time the bus is due in the morning (pick-up) and afternoon (drop).
create table route_stop (
  id              uuid primary key default gen_random_uuid(),
  route_id        uuid not null references route (id),
  seq             smallint not null check (seq between 1 and 60),
  name            text not null check (length(trim(name)) > 1),
  landmark        text,
  morning_time    time,
  afternoon_time  time,
  fare_zone       text not null,
  active          boolean not null default true,
  unique (route_id, seq) deferrable initially deferred
);
create trigger route_stop_audit after insert or update on route_stop for each row execute function audit_row();

-- Which stop a child uses, from when to when. One at a time; the history is kept.
create table transport_allocation (
  id              uuid primary key default gen_random_uuid(),
  enrolment_id    uuid not null references enrolment (id),
  student_id      uuid not null references student (id),
  pickup_stop_id  uuid references route_stop (id),
  drop_stop_id    uuid references route_stop (id),
  valid           daterange not null check (not isempty(valid)),
  approved_by     uuid not null references app_user (id),
  created_at      timestamptz not null default now(),
  check (pickup_stop_id is not null or drop_stop_id is not null),
  exclude using gist (student_id with =, valid with &&)
);
create index transport_allocation_stop on transport_allocation (pickup_stop_id);
create trigger transport_allocation_audit after insert or update on transport_allocation for each row execute function audit_row();

-- A parent (or the office) asks to start, change or stop; the transport in-charge decides.
create table transport_request (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references org_unit (id),
  student_id      uuid not null references student (id),
  kind            text not null check (kind in ('START', 'CHANGE', 'STOP')),
  pickup_stop_id  uuid references route_stop (id),
  drop_stop_id    uuid references route_stop (id),
  from_date       date not null,
  note            text not null default '',
  status          text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by    uuid not null references app_user (id),
  decided_by      uuid references app_user (id),
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),
  check (kind = 'STOP' or pickup_stop_id is not null or drop_stop_id is not null)
);
create unique index transport_request_open on transport_request (student_id) where status = 'PENDING';
create trigger transport_request_audit after insert or update on transport_request for each row execute function audit_row();

-- Each day's run of a route, morning and afternoon, and what happened on it.
create table trip (
  id          uuid primary key default gen_random_uuid(),
  route_id    uuid not null references route (id),
  on_date     date not null,
  leg         text not null check (leg in ('MORNING', 'AFTERNOON')),
  status      text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'RUNNING', 'DONE', 'CANCELLED')),
  delay_min   smallint not null default 0,
  alerted_min smallint not null default 0,              -- the delay parents were last told about
  last_stop_seq smallint,
  note        text,
  unique (route_id, on_date, leg)
);
create table trip_event (
  id         bigserial primary key,
  trip_id    uuid not null references trip (id),
  kind       text not null check (kind in ('STARTED', 'AT_STOP', 'DELAY', 'REACHED', 'CANCELLED', 'BREAKDOWN', 'POSITION')),
  stop_id    uuid references route_stop (id),
  minutes    smallint,
  lat        numeric(9,6),
  lng        numeric(9,6),
  note       text,
  at         timestamptz not null default now(),
  by_user    uuid references app_user (id)
);
create index trip_event_trip on trip_event (trip_id, at);
create trigger trip_event_immutable before update or delete on trip_event for each row execute function forbid_change();

-- Who got on and off.
create table boarding (
  trip_id     uuid not null references trip (id),
  student_id  uuid not null references student (id),
  status      text not null check (status in ('BOARDED', 'DROPPED', 'NOT_BOARDED', 'HANDED_TO_PARENT')),
  at          timestamptz not null default now(),
  marked_by   uuid not null references app_user (id),
  primary key (trip_id, student_id)
);
create trigger boarding_audit after insert or update on boarding for each row execute function audit_row();

alter table notification drop constraint notification_kind_check;
alter table notification add constraint notification_kind_check
  check (kind in ('HOMEWORK', 'NOTICE', 'ATTENDANCE', 'LEAVE', 'MESSAGE', 'FEES', 'EVENT', 'RESULT', 'AWARD', 'PROXY', 'LIBRARY', 'CERTIFICATE', 'TRANSFER', 'CHAT', 'PAY', 'TRANSPORT'));
