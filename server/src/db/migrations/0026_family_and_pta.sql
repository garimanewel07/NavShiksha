-- Families, and the PTA fee that a family pays once (for one child, however many are at the school).

-- A child's family: every child who shares a parent or guardian with them (and the child).
-- Brothers and sisters are never entered as such; they follow from the parents on the admission form.
create function family_of(child uuid) returns table (student_id uuid) language sql stable as $$
  select distinct sg2.student_id from student_guardian sg1 join student_guardian sg2 on sg2.guardian_id = sg1.guardian_id where sg1.student_id = child
  union select child
$$;

-- The PTA fee is collected for the Parent-Teacher Association: the school holds it, it is not the school's income.
insert into ledger_account (code, name, type) values ('2320', 'PTA fund, held for the Parent-Teacher Association', 'LIABILITY') on conflict do nothing;
insert into fee_head (code, name, income_account, refundable, alloc_priority, kind) values ('PTA', 'PTA fee (one per family)', '2320', false, 11, 'PLAN');
