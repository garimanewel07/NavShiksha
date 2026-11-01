-- Holistic Progress Cards in the format NES prescribes (Balvatika to Class V): the template for
-- each class, the ratings a class teacher gives each child each term, the child's "All About Me"
-- page, the drawings and photographs on the glimpse pages, and staff signatures for printing.
-- Additive only.

-- NES's template for a class. With no row, the default in reference/hpcTemplates.ts applies.
create table hpc_template (
  class_code  text primary key references class_level (code),
  body        jsonb not null check (jsonb_typeof(body) = 'object' and body ? 'parts'),
  version     int not null default 1,
  updated_by  uuid not null references app_user (id),
  updated_at  timestamptz not null default now()
);
create trigger hpc_template_version before update on hpc_template for each row execute function bump_version();
create trigger hpc_template_audit after insert or update or delete on hpc_template for each row execute function audit_row();

-- One rating per child, per item, per term (assessment): stars or plants 1-3 or NA, smileys 1-3,
-- a choice from the item's scale, YES/NO, or a short answer. Only while the assessment is open.
create table hpc_rating (
  assessment_id  uuid not null references assessment (id),
  enrolment_id   uuid not null references enrolment (id),
  item_id        text not null check (item_id ~ '^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$'),
  value          text not null check (length(trim(value)) between 1 and 400),
  entered_by     uuid not null references app_user (id),
  entered_at     timestamptz not null default now(),
  primary key (assessment_id, enrolment_id, item_id)
);
create trigger hpc_rating_guard before insert or update or delete on hpc_rating for each row execute function report_guard();
create trigger hpc_rating_audit after insert or update or delete on hpc_rating for each row execute function audit_row();

-- "All About Me": the child's favourites for the year, filled by the parent or the class teacher.
-- Names, date of birth, class, height and weight come from the records already kept.
create table hpc_profile (
  enrolment_id  uuid primary key references enrolment (id),
  answers       jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  updated_by    uuid not null references app_user (id),
  updated_at    timestamptz not null default now()
);
create trigger hpc_profile_audit after insert or update or delete on hpc_profile for each row execute function audit_row();

-- The glimpse pages: the child's drawing of the family and of themselves, and portfolio work.
create table hpc_photo (
  id            uuid primary key default gen_random_uuid(),
  enrolment_id  uuid not null references enrolment (id),
  kind          text not null check (kind in ('FAMILY', 'SELF', 'PORTFOLIO')),
  caption       text not null default '' check (length(caption) <= 80),
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  data          bytea not null check (octet_length(data) <= 1572864),
  uploaded_by   uuid not null references app_user (id),
  uploaded_at   timestamptz not null default now()
);
create index hpc_photo_enrolment on hpc_photo (enrolment_id, kind);
create trigger hpc_photo_audit after insert or delete on hpc_photo for each row execute function audit_row();

-- A teacher's own signature, printed on the report cards they sign as class teacher.
create table staff_signature (
  user_id       uuid primary key references app_user (id),
  content_type  text not null check (content_type in ('image/jpeg', 'image/png')),
  data          bytea not null check (octet_length(data) <= 262144),
  uploaded_at   timestamptz not null default now()
);
create trigger staff_signature_audit after insert or update or delete on staff_signature for each row execute function audit_row();

-- A school may replace the cover picture of its cards with its own artwork.
alter table print_asset drop constraint print_asset_kind_check;
alter table print_asset add constraint print_asset_kind_check check (kind in ('LOGO', 'SIGNATURE', 'STAMP', 'HPC_COVER'));
