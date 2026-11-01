-- People: ranks, guardians and their dated service facts, students, enrolments.

create table rank (
  code     text primary key,
  service  text not null check (service in ('NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD')),
  name     text not null,
  band     text not null check (band in ('OFFICER', 'CPO_AND_ABOVE', 'PO_AND_BELOW'))
);
-- Rank equivalence across services is data: changing a band never needs a code change.
insert into rank (code, service, name, band) values
  ('N_ADM', 'NAVY', 'Admiral', 'OFFICER'), ('N_CDRE', 'NAVY', 'Commodore', 'OFFICER'), ('N_CAPT', 'NAVY', 'Captain', 'OFFICER'),
  ('N_CDR', 'NAVY', 'Commander', 'OFFICER'), ('N_LCDR', 'NAVY', 'Lieutenant Commander', 'OFFICER'), ('N_LT', 'NAVY', 'Lieutenant', 'OFFICER'),
  ('N_SLT', 'NAVY', 'Sub Lieutenant', 'OFFICER'), ('N_MCPO1', 'NAVY', 'Master Chief Petty Officer I', 'CPO_AND_ABOVE'),
  ('N_MCPO2', 'NAVY', 'Master Chief Petty Officer II', 'CPO_AND_ABOVE'), ('N_CPO', 'NAVY', 'Chief Petty Officer', 'CPO_AND_ABOVE'),
  ('N_PO', 'NAVY', 'Petty Officer', 'PO_AND_BELOW'), ('N_LS', 'NAVY', 'Leading Seaman', 'PO_AND_BELOW'), ('N_SEA', 'NAVY', 'Seaman', 'PO_AND_BELOW'),
  ('A_COL', 'ARMY', 'Colonel', 'OFFICER'), ('A_MAJ', 'ARMY', 'Major', 'OFFICER'), ('A_SUB', 'ARMY', 'Subedar', 'CPO_AND_ABOVE'),
  ('A_NSUB', 'ARMY', 'Naib Subedar', 'CPO_AND_ABOVE'), ('A_HAV', 'ARMY', 'Havildar', 'PO_AND_BELOW'),
  ('AF_WGCDR', 'AIR_FORCE', 'Wing Commander', 'OFFICER'), ('AF_JWO', 'AIR_FORCE', 'Junior Warrant Officer', 'CPO_AND_ABOVE'),
  ('AF_SGT', 'AIR_FORCE', 'Sergeant', 'PO_AND_BELOW'), ('CG_COMDT', 'COAST_GUARD', 'Commandant', 'OFFICER'),
  ('CG_PRADHAN', 'COAST_GUARD', 'Pradhan Adhikari', 'CPO_AND_ABOVE'), ('CG_NAVIK', 'COAST_GUARD', 'Navik', 'PO_AND_BELOW');

create table guardian (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 1),
  phone       text not null unique check (phone ~ '^\+91[6-9]\d{9}$'),
  email       text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz not null default now(),
  version     int not null default 1,
  updated_at  timestamptz not null default now()
);
create trigger guardian_version before update on guardian for each row execute function bump_version();
create trigger guardian_audit after insert or update or delete on guardian for each row execute function audit_row();

alter table app_user add constraint app_user_guardian_fk foreign key (guardian_id) references guardian (id);

-- What is true about a guardian's service, and when. Categories and fee bands are derived from
-- these facts at a date, so a retirement or posting change applies from its date automatically.
create table guardian_service_fact (
  id                 uuid primary key default gen_random_uuid(),
  guardian_id        uuid not null references guardian (id),
  valid              daterange not null check (not isempty(valid)),
  service            text not null check (service in ('NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD',
                       'DEF_CIV_NAVY', 'DEF_CIV_ARMY_AF', 'NES_STAFF', 'CIVILIAN')),
  status             text not null check (status in ('SERVING', 'DEPUTATION_NAVY', 'ESM_PENSION',
                       'ESM_NO_PENSION', 'RETIRED', 'DIED_IN_SERVICE', 'NONE')),
  rank_code          text references rank (code),
  civil_officer      boolean not null default false,
  posted_in_station  boolean not null default false,
  evidence           text,
  created_at         timestamptz not null default now(),
  exclude using gist (guardian_id with =, valid with &&),
  check (service in ('NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD') = (rank_code is not null)),
  check (civil_officer = false or service in ('DEF_CIV_NAVY', 'DEF_CIV_ARMY_AF'))
);
-- A fact can only be closed (its end date set), never rewritten.
create function service_fact_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'service facts are permanent' using errcode = 'check_violation';
  end if;
  if (new.guardian_id, lower(new.valid), new.service, new.status, new.rank_code, new.civil_officer, new.posted_in_station)
     is distinct from (old.guardian_id, lower(old.valid), old.service, old.status, old.rank_code, old.civil_officer, old.posted_in_station)
     or not upper_inf(old.valid) then
    raise exception 'a service fact can only be closed; add a new fact for the change' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger service_fact_guard before update or delete on guardian_service_fact for each row execute function service_fact_guard();
create trigger service_fact_audit after insert or update on guardian_service_fact for each row execute function audit_row();

create sequence nes_student_seq start 100001;

create table student (
  id          uuid primary key default gen_random_uuid(),
  nes_id      text not null unique default ('NES-' || nextval('nes_student_seq')),
  name        text not null check (length(trim(name)) > 1),
  dob         date not null check (dob > date '2005-01-01'),
  gender      text not null check (gender in ('F', 'M', 'X')),
  apaar_id    text unique,
  pen         text unique,
  created_at  timestamptz not null default now(),
  version     int not null default 1,
  updated_at  timestamptz not null default now()
);
create trigger student_version before update on student for each row execute function bump_version();
create trigger student_audit after insert or update or delete on student for each row execute function audit_row();

create table student_guardian (
  student_id    uuid not null references student (id),
  guardian_id   uuid not null references guardian (id),
  relationship  text not null check (relationship in ('FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT')),
  is_primary    boolean not null default false,
  primary key (student_id, guardian_id)
);
create unique index student_one_primary_guardian on student_guardian (student_id) where is_primary;
create trigger student_guardian_audit after insert or update or delete on student_guardian for each row execute function audit_row();

create table admission_counter (
  school_id  uuid not null references org_unit (id),
  year       text not null references academic_year (code),
  last_no    int not null default 0,
  primary key (school_id, year)
);

-- One child, one school at any moment: enrolment periods for a student can never overlap.
create table enrolment (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references student (id),
  school_id           uuid not null references org_unit (id),
  campus_id           uuid not null references org_unit (id),
  section_id          uuid references section (id),
  academic_year       text not null references academic_year (code),
  class_code          text not null references class_level (code),
  admission_no        text not null,
  status              text not null check (status in ('PROVISIONAL', 'ACTIVE', 'TRANSFERRED_OUT', 'WITHDRAWN', 'COMPLETED')),
  period              daterange not null check (not isempty(period)),
  admission_category  text not null,
  category_snapshot   jsonb not null,
  tc_due_date         date,
  transferred_to      uuid references enrolment (id),
  created_at          timestamptz not null default now(),
  version             int not null default 1,
  updated_at          timestamptz not null default now(),
  unique (school_id, admission_no),
  exclude using gist (student_id with =, period with &&),
  check (status <> 'PROVISIONAL' or tc_due_date is not null),
  check ((status in ('PROVISIONAL', 'ACTIVE')) = upper_inf(period))
);
create index enrolment_school_active on enrolment (school_id) where status in ('PROVISIONAL', 'ACTIVE');

create function enrolment_check_place() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from org_unit c where c.id = new.campus_id and c.kind = 'campus' and c.parent_id = new.school_id) then
    raise exception 'the campus does not belong to this school' using errcode = 'check_violation';
  end if;
  if new.section_id is not null and not exists (
      select 1 from section s where s.id = new.section_id and s.campus_id = new.campus_id
         and s.class_code = new.class_code and s.academic_year = new.academic_year) then
    raise exception 'the section does not match this campus, class and year' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger enrolment_check_place before insert or update of campus_id, section_id, class_code, school_id
  on enrolment for each row execute function enrolment_check_place();
create trigger enrolment_version before update on enrolment for each row execute function bump_version();
create trigger enrolment_audit after insert or update or delete on enrolment for each row execute function audit_row();
