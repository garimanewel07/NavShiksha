-- Category schemes: admission priority (Cat 1 … 4B) and fee bands, as versioned, dated data.

create table category_scheme (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid references org_unit (id),            -- null: the NES-wide default
  kind        text not null check (kind in ('ADMISSION', 'FEE_BAND')),
  name        text not null,
  version     int not null check (version > 0),
  valid       daterange not null check (not isempty(valid)),
  status      text not null check (status in ('DRAFT', 'PUBLISHED')),
  created_at  timestamptz not null default now(),
  unique (school_id, kind, version),
  exclude using gist (
    (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    kind with =, valid with &&) where (status = 'PUBLISHED')
);

create table category_rule (
  id             uuid primary key default gen_random_uuid(),
  scheme_id      uuid not null references category_scheme (id),
  code           text not null,
  label          text not null,
  priority       int not null check (priority > 0),
  condition      jsonb not null,
  required_docs  text[] not null default '{}',
  unique (scheme_id, code),
  unique (scheme_id, priority)
);

-- Published schemes are frozen. To change a scheme, publish a new version with a start date.
-- The only change allowed on a published scheme is setting its end date when the next one starts.
create function scheme_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.status = 'PUBLISHED' then
    raise exception 'published schemes are permanent' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status = 'PUBLISHED' and (
       (new.school_id, new.kind, new.name, new.version, new.status, lower(new.valid))
       is distinct from (old.school_id, old.kind, old.name, old.version, old.status, lower(old.valid))) then
    raise exception 'a published scheme can only be given an end date' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger scheme_guard before update or delete on category_scheme for each row execute function scheme_guard();

create function scheme_rule_guard() returns trigger language plpgsql as $$
declare s text;
begin
  select status into s from category_scheme where id = coalesce(new.scheme_id, old.scheme_id);
  if s = 'PUBLISHED' then
    raise exception 'rules of a published scheme cannot change' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger scheme_rule_guard before insert or update or delete on category_rule for each row execute function scheme_rule_guard();
create trigger category_scheme_audit after insert or update or delete on category_scheme for each row execute function audit_row();
