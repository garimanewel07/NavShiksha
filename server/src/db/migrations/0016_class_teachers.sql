-- Class teachers, with history. A section has one class teacher and at most one co-class teacher
-- at a time; a teacher is class teacher of only one section at a time. Changing a class teacher
-- mid-year closes the old assignment and opens a new one, so "who was class teacher on 3 August"
-- always has one answer. Replaces section.class_teacher_id.

create table class_teacher (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references section (id),
  user_id      uuid not null references app_user (id),
  kind         text not null check (kind in ('CLASS', 'CO')),
  valid        daterange not null check (not isempty(valid) and not lower_inf(valid)),
  assigned_by  uuid not null references app_user (id),
  created_at   timestamptz not null default now(),
  exclude using gist (section_id with =, kind with =, valid with &&),
  exclude using gist (user_id with =, valid with &&) where (kind = 'CLASS')
);
create index class_teacher_user on class_teacher (user_id);

create function class_teacher_check() returns trigger language plpgsql as $$
declare yr daterange;
begin
  if not exists (
    select 1 from app_user u join section s on s.id = new.section_id join org_unit c on c.id = s.campus_id join org_unit o on o.id = c.parent_id
     where u.id = new.user_id and u.active and u.role = 'TEACHER' and u.scope_path <@ o.path) then
    raise exception 'a class teacher must be a teacher of that school' using errcode = 'check_violation';
  end if;
  select y.period into yr from section s join academic_year y on y.code = s.academic_year where s.id = new.section_id;
  if yr is not null and not (new.valid <@ yr) then
    raise exception 'a class teacher assignment must fall within the class''s academic year' using errcode = 'check_violation';
  end if;
  if exists (select 1 from class_teacher x where x.section_id = new.section_id and x.user_id = new.user_id and x.id <> new.id and x.valid && new.valid) then
    raise exception 'the same teacher cannot be both class teacher and co-class teacher of a class' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.section_id <> old.section_id or new.kind <> old.kind or lower(new.valid) <> lower(old.valid)) then
    raise exception 'a class teacher assignment cannot be edited; end it and make a new one' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger class_teacher_check before insert or update on class_teacher for each row execute function class_teacher_check();
create trigger class_teacher_audit after insert or update on class_teacher for each row execute function audit_row();
-- Assignments that have not started yet may be removed; history may not.
create function class_teacher_future_only() returns trigger language plpgsql as $$
begin
  if lower(old.valid) <= current_date then
    raise exception 'a class teacher assignment that has started cannot be deleted; end it instead' using errcode = 'check_violation';
  end if;
  return old;
end $$;
create trigger class_teacher_delete before delete on class_teacher for each row execute function class_teacher_future_only();

create function class_teacher_of(p_section uuid, p_on date default current_date, p_kind text default 'CLASS') returns uuid
  language sql stable as $$
  select user_id from class_teacher where section_id = p_section and kind = p_kind and valid @> p_on
$$;

-- Carry over existing class teachers from the start of their academic year (or today).
insert into class_teacher (section_id, user_id, kind, valid, assigned_by)
select s.id, s.class_teacher_id, 'CLASS', daterange(least(coalesce(lower(y.period), current_date), current_date), upper(y.period)), s.class_teacher_id
  from section s left join academic_year y on y.code = s.academic_year
 where s.class_teacher_id is not null;
alter table section drop column class_teacher_id;

-- "Class teacher time": a bell slot (before Period 1, after lunch…) when every class teacher is
-- with their own class for the roll, the diary and announcements.
alter table bell_slot drop constraint bell_slot_kind_check;
alter table bell_slot add constraint bell_slot_kind_check check (kind in ('PERIOD', 'ASSEMBLY', 'BREAK', 'LUNCH', 'ACTIVITY', 'CLASS_TEACHER'));
