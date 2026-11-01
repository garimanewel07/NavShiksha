-- R2: website builder. Each school edits a draft of its site and publishes it. Every publish is
-- an immutable release, so the public site can be rolled back to any earlier version, and the
-- draft carries a version number so two editors cannot overwrite each other.

create table site (
  school_id      uuid primary key references org_unit (id),
  slug           text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  draft          jsonb not null,
  draft_version  int not null default 1,
  updated_by     uuid references app_user (id),
  updated_at     timestamptz not null default now()
);
create function site_check_school() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from org_unit where id = new.school_id and kind = 'school') then
    raise exception 'a website belongs to a school' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger site_check_school before insert or update of school_id on site for each row execute function site_check_school();
create trigger site_audit after insert or update on site for each row execute function audit_row();

create table site_release (
  id            bigserial primary key,
  school_id     uuid not null references site (school_id),
  version       int not null check (version > 0),
  content       jsonb not null,
  note          text not null default '',
  published_by  uuid not null references app_user (id),
  published_at  timestamptz not null default now(),
  unique (school_id, version)
);
create trigger site_release_immutable before update or delete on site_release for each row execute function forbid_change();
create trigger site_release_audit after insert on site_release for each row execute function audit_row();

-- Images for the website. Kept small and to safe types; the API also checks the file signature.
create table site_asset (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references site (school_id),
  name          text not null check (length(name) between 1 and 120),
  content_type  text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes         bytea not null check (octet_length(bytes) between 1 and 2097152),
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now()
);
create trigger site_asset_audit after insert or delete on site_asset for each row execute function audit_row();

-- Enquiries sent from the public contact form. Visitors can only add; staff only change status.
create table site_enquiry (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references site (school_id),
  name        text not null check (length(trim(name)) between 2 and 80),
  phone       text not null check (phone ~ '^\+?[0-9 ]{10,15}$'),
  topic       text not null check (topic in ('Admissions', 'Fees', 'Transfer certificate', 'Careers', 'Other')),
  message     text not null check (length(trim(message)) between 5 and 2000),
  status      text not null default 'NEW' check (status in ('NEW', 'REPLIED', 'CLOSED')),
  created_at  timestamptz not null default now()
);
create index site_enquiry_school on site_enquiry (school_id, created_at desc);
create trigger site_enquiry_guard before update or delete on site_enquiry for each row execute function only_changes('status');
