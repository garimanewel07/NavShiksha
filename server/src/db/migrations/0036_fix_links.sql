-- Notifications already sent with links to pages that do not exist: point them at the real ones.
-- Sent notifications are otherwise unchangeable (only read_at), so the guard is lifted for this
-- one correction and restored in the same migration.
alter table notification disable trigger notification_guard;
update notification set link = '/staff-leave' where link = '/staff/leave';
update notification set link = '/my/pay' where link in ('/my/leave', '/my/service');
alter table notification enable trigger notification_guard;
