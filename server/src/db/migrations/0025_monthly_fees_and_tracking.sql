-- Monthly fees, and four ways to follow a school bus.

-- A school may bill by the month (M04 = April … M03 = March) instead of by the quarter, for any
-- months it has not billed yet. The rates stay as NES sets them; a month is a third of the quarter.
alter table fee_installment drop constraint fee_installment_code_check;
alter table fee_installment add constraint fee_installment_code_check check (code ~ '^(Q[1-4]|M(0[1-9]|1[0-2]))$');

-- How a route is followed:
--   TIMES   only the stop times are shown to parents; nothing to tap, nothing tracked;
--   TAPS    stop times, moved by the attendant's taps (started, at this stop, running late);
--   PHONE   the attendant's phone shares its location during the run; arrival at each stop is noticed by itself;
--   DEVICE  a tracker fitted in the vehicle sends its position.
alter table route drop constraint route_tracking_check;
update route set tracking = case tracking when 'GPS' then 'PHONE' else 'TAPS' end;
alter table route alter column tracking set default 'TAPS';
alter table route add constraint route_tracking_check check (tracking in ('TIMES', 'TAPS', 'PHONE', 'DEVICE'));

-- Where each stop is, learnt the first time the attendant taps "at this stop" with location on
-- (or set by the office), so later runs notice the arrival by themselves.
alter table route_stop add column lat numeric(9,6), add column lng numeric(9,6);

-- A fitted tracker identifies itself with a secret token, given to the tracker company.
alter table vehicle add column tracker_token text unique;

alter table trip_event drop constraint trip_event_kind_check;
alter table trip_event add constraint trip_event_kind_check check (kind in ('STARTED', 'AT_STOP', 'DELAY', 'REACHED', 'CANCELLED', 'BREAKDOWN', 'POSITION', 'AUTO_AT_STOP'));
