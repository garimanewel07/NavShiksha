-- Organisation: NES → Command → School → Campus. Mergers, academic years, classes, sections, users.

create table org_unit (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('society', 'command', 'school', 'campus')),
  code          text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  name          text not null check (length(trim(name)) > 0),
  parent_id     uuid references org_unit (id),
  path          ltree not null unique,
  school_type   text check (school_type in ('NCS', 'NKG')),
  affiliation_no text,
  udise_code    text unique,
  address       text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  version       int not null default 1,
  updated_at    timestamptz not null default now(),
  check ((kind = 'society') = (parent_id is null)),
  check ((kind = 'school') = (school_type is not null)),
  check (kind <> 'campus' or address is not null)
);

-- The path is always derived from the parent, never typed by hand, and the parent kind must fit.
create function org_unit_place() returns trigger language plpgsql as $$
declare p record;
begin
  if new.parent_id is null then
    new.path := text2ltree(lower(replace(replace(new.code, '-', '_'), ' ', '_')));
    return new;
  end if;
  select kind, path into p from org_unit where id = new.parent_id;
  if not found then raise exception 'parent unit does not exist' using errcode = 'foreign_key_violation'; end if;
  if (new.kind = 'command' and p.kind <> 'society')
     or (new.kind = 'school' and p.kind not in ('command', 'society'))
     or (new.kind = 'campus' and p.kind <> 'school') then
    raise exception 'a % cannot sit under a %', new.kind, p.kind using errcode = 'check_violation';
  end if;
  new.path := p.path || text2ltree(lower(replace(replace(new.code, '-', '_'), ' ', '_')));
  return new;
end $$;
create trigger org_unit_place before insert or update of parent_id, code on org_unit
  for each row execute function org_unit_place();

-- Moving a unit (for example a campus re-homed by a merger) moves its whole subtree.
create function org_unit_move_subtree() returns trigger language plpgsql as $$
begin
  if new.path is distinct from old.path then
    update org_unit set path = new.path || subpath(path, nlevel(old.path))
     where path <@ old.path and id <> new.id;
  end if;
  return null;
end $$;
create trigger org_unit_move_subtree after update of path on org_unit
  for each row execute function org_unit_move_subtree();
create trigger org_unit_version before update on org_unit for each row execute function bump_version();
create trigger org_unit_audit after insert or update or delete on org_unit for each row execute function audit_row();

-- A merger is a dated event: the merged school's campuses join the surviving school;
-- the merged school stays in history (inactive) with all its records intact.
create table org_merger (
  id                  uuid primary key default gen_random_uuid(),
  merged_school_id    uuid not null unique references org_unit (id),
  surviving_school_id uuid not null references org_unit (id),
  effective_date      date not null,
  note                text,
  created_at          timestamptz not null default now(),
  check (merged_school_id <> surviving_school_id)
);
create trigger org_merger_audit after insert or update or delete on org_merger for each row execute function audit_row();
create trigger org_merger_immutable before update or delete on org_merger for each row execute function forbid_change();

create table academic_year (
  code    text primary key check (code ~ '^\d{4}-\d{2}$'),
  period  daterange not null check (not isempty(period)),
  exclude using gist (period with &&)
);

create table class_level (
  code        text primary key,
  name        text not null,
  ordinal     int not null unique,
  stage       text not null check (stage in ('foundational', 'preparatory', 'middle', 'secondary')),
  fee_band    text not null check (fee_band in ('PRE', 'PRIMARY', 'MIDDLE', 'SECONDARY', 'SENIOR'))
);
insert into class_level (code, name, ordinal, stage, fee_band) values
  ('BV1', 'Balvatika 1', 1, 'foundational', 'PRE'), ('BV2', 'Balvatika 2', 2, 'foundational', 'PRE'),
  ('BV3', 'Balvatika 3', 3, 'foundational', 'PRE'), ('I', 'Class I', 4, 'foundational', 'PRIMARY'),
  ('II', 'Class II', 5, 'foundational', 'PRIMARY'), ('III', 'Class III', 6, 'preparatory', 'PRIMARY'),
  ('IV', 'Class IV', 7, 'preparatory', 'PRIMARY'), ('V', 'Class V', 8, 'preparatory', 'PRIMARY'),
  ('VI', 'Class VI', 9, 'middle', 'MIDDLE'), ('VII', 'Class VII', 10, 'middle', 'MIDDLE'),
  ('VIII', 'Class VIII', 11, 'middle', 'MIDDLE'), ('IX', 'Class IX', 12, 'secondary', 'SECONDARY'),
  ('X', 'Class X', 13, 'secondary', 'SECONDARY'), ('XI', 'Class XI', 14, 'secondary', 'SENIOR'),
  ('XII', 'Class XII', 15, 'secondary', 'SENIOR');

create table section (
  id            uuid primary key default gen_random_uuid(),
  campus_id     uuid not null references org_unit (id),
  academic_year text not null references academic_year (code),
  class_code    text not null references class_level (code),
  name          text not null check (name ~ '^[A-Z]$'),
  capacity      int not null check (capacity between 1 and 60),
  unique (campus_id, academic_year, class_code, name)
);
create function section_check_campus() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from org_unit where id = new.campus_id and kind = 'campus') then
    raise exception 'sections belong to a campus' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger section_check_campus before insert or update on section for each row execute function section_check_campus();

create table app_user (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  role         text not null check (role in ('NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'TEACHER', 'PARENT')),
  designation  text,
  scope_path   ltree,
  guardian_id  uuid,
  active       boolean not null default true,
  check ((role = 'PARENT') = (guardian_id is not null)),
  check (role = 'PARENT' or scope_path is not null)
);

create table app_session (
  token       text primary key,
  user_id     uuid not null references app_user (id),
  expires_at  timestamptz not null
);
