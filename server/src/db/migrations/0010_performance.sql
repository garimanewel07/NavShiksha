-- Indexes for the "what is owed" checks, which run on every payment and allocation.
create index fee_demand_group on fee_demand (enrolment_id, installment_code, head_code);
create index payment_allocation_demand on payment_allocation (demand_id);
create index enrolment_student on enrolment (student_id);
create index enrolment_section on enrolment (section_id) where section_id is not null;
