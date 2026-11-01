-- One record per person, entered once. Every module reads a person's details from one place:
-- the sign-in (name, phone, email), the staff record (dates, blood group, identity numbers, pay)
-- and the student record (with the family's details on the guardians). Nothing is copied.

-- ── Staff ──────────────────────────────────────────────────────────────────────────────────
-- The phone and email belong to the person (they sign in with them), not to an ID card.
alter table app_user add column phone text unique check (phone ~ '^\+91[6-9][0-9]{9}$');
alter table app_user add column email text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- What the ID card, the library and the service book used to keep separately now lives on the staff record.
alter table employee add column dob date check (dob > date '1940-01-01');
alter table employee add column blood_group text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));
alter table employee add column emergency_contact text check (length(emergency_contact) <= 120);
-- The person's own title when no sanctioned post says it ("Gardener", "Guest teacher, Music"). Designations are worked out from it,
-- the post, the subject taught and any class-teacher role, never typed twice.
alter table employee add column title text check (length(title) <= 80);
alter table employee add column employee_no text check (length(trim(employee_no)) between 1 and 20);   -- the school's own staff number, from the old ERP
create unique index employee_school_no on employee (school_id, upper(employee_no)) where employee_no is not null;

insert into employee (user_id, school_id, employment, category, joined_service)
select p.user_id, p.school_id, 'PERMANENT', case when u.role in ('TEACHER', 'SCHOOL_ADMIN') then 'TEACHING' else 'NON_TEACHING' end, coalesce(p.joined_on, current_date)
  from staff_profile p join app_user u on u.id = p.user_id where not exists (select 1 from employee e where e.user_id = p.user_id);
update employee e set dob = p.dob, blood_group = p.blood_group, emergency_contact = p.emergency_contact, employee_no = p.employee_no from staff_profile p where p.user_id = e.user_id;
update app_user u set phone = p.phone from staff_profile p where p.user_id = u.id and p.phone is not null and not exists (select 1 from app_user x where x.phone = p.phone);
drop table staff_profile;

-- Read-only, for the ID cards and the library desk.
create view staff_profile as
  select e.user_id, e.school_id, coalesce(e.employee_no, e.nes_staff_id) as employee_no, e.blood_group, u.phone, e.dob, e.joined_service as joined_on, e.emergency_contact, e.version
    from employee e join app_user u on u.id = e.user_id where e.separated_on is null or e.separated_on >= current_date;

-- ── Students and families ──────────────────────────────────────────────────────────────────
-- The family's address is kept once, on the guardian, and shared by brothers and sisters.
alter table guardian add column address text check (length(address) <= 300);
alter table student add column previous_school text check (length(previous_school) <= 160);

-- Everything the school needs is asked once, on the admission form, and carried into the records on admission.
alter table application add column child_blood_group text check (child_blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));
alter table application add column child_apaar_id text check (child_apaar_id ~ '^[0-9]{12}$');
alter table application add column child_pen text check (child_pen ~ '^[0-9]{11}$');
alter table application add column previous_school text check (length(previous_school) <= 160);
alter table application add column address text check (length(address) <= 300);
alter table application add column other_parent jsonb;          -- {"name", "phone", "email", "relationship"}: the second parent
