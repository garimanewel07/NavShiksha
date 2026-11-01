# Who sees what

The rules are data in `server/src/modules/access.ts`; this page is the readable version. The full plan, role by role, is `NES_Roles_and_Access.html` in the ERP folder.

## Parts of a child's record

| Part | Parent | Subject teacher | Class / co-class teacher | Accountant | Principal | Command | NES |
|---|---|---|---|---|---|---|---|
| Name, class, house | yes | yes | yes | yes | yes | yes | yes |
| Attendance | yes | yes | yes | – | yes | yes | yes |
| Marks and results | yes | yes | yes | – | yes | yes | yes |
| Leave requests | yes | – | yes | – | yes | – | yes |
| Parents' contacts | yes | – | yes | yes | yes | – | yes |
| Health notes | yes | – | yes | – | yes | – | yes |
| Documents | yes | – | yes | – | yes | – | yes |
| Parent's service and rank | own | – | – | yes | yes | yes | yes |
| Admission category, fee band | – | – | – | yes | yes | yes | yes |
| Fees overdue or clear | yes | – | if the school allows | yes | yes | – | yes |
| Fee amounts and receipts | yes | – | – | yes | yes | – | yes |

"Subject teacher" means a lesson with the child's class on the current timetable; any other teacher sees only the first row. Duties add: admission in-charge (contacts, service, category, documents), attendance officer (contacts, attendance, leave), counsellor (contacts, health, attendance, marks), exam in-charge (marks), transport in-charge (contacts).

## School-wide permissions

| Permission | Given to |
|---|---|
| Dashboards | Principal, Command, NES |
| Fee plans, dues, defaulters; collections and receipts | Accountant, principal, NES |
| Counter payments | Accountant, principal |
| Applications and seats | Principal, Command, NES; admission in-charge |
| Categories and fee bands | Accountant, principal, Command, NES; admission in-charge |
| Student list download | Principal, NES; admission in-charge |
| Attendance registers (all classes) | Principal, Command, NES; attendance officer (class teachers: own class) |
| Result analysis | Principal, Command, NES; exam in-charge (teachers: own classes) |
| Cover board, teaching loads, generator | Principal; timetable coordinator |
| Class teachers and duties | Principal, NES |
| Audit log | NES |

## Fees, charges and refunds

| Action | Who |
|---|---|
| Draft a fee revision | Accountant, principal, NES |
| Approve a fee revision | Principal or NES, never the person who drafted it |
| Raise an additional charge (CBSE, trip, event) | Accountant or principal |
| Approve a charge | Principal or NES, never the person who raised it |
| Excuse a child from a charge, cancel a charge | Principal or NES, with a reason |
| Reply yes or no for a child | The child's parent (until the reply date); the teacher in charge, the class teacher or the office for a paper slip |
| See a charge's children | Fee desk and principal: with amounts. Teacher in charge: everyone, paid or not, no amounts. Class teacher: their own class, paid or not |
| Add new children, close replies, record a payout to CBSE or an operator | Accountant or principal |
| Request a refund; record a refund as paid | Accountant or principal (other refunds are approved through the chain first) |
| Pay fees and charges | Parent (online), accountant or principal (counter) |

## Library, ID cards, certificates and printing

| Action | Who |
|---|---|
| Library: catalogue, issue and return, labels, import | Principal, NES; librarian duty |
| A child's library books | The parent; staff who can see the child |
| ID cards: design, print, photos, staff details | Principal, NES; admission in-charge (office) duty. Class teachers can add photos for their own class |
| Certificates: prepare, correct, send for approval, print | Principal, NES; admission in-charge (office) duty |
| Certificates: approve | The school's approval chain (default: principal; TC: class teacher, then principal). A principal's own submission issues at once |
| Certificates: issue a whole class, cancel an issued one | Principal, NES |
| Request a certificate, download an issued one | The child's parent |
| Check a certificate | Anyone with its code (public page, shows only what is printed on it) |
| Printers, calibration, stationery, school logo | Principal, NES; librarian or admission in-charge duty. Signature and stamp: principal only |

## Moving a child to another Navy school

| Action | Who |
|---|---|
| See which Navy Children Schools and Navy Kindergartens teach the child's class | The parent (seats available or full); the present school's principal or admission in-charge (with numbers) |
| Ask another school for a seat | The parent (in the app, with a TC request) or the present school's principal or admission in-charge |
| Accept into a section (only with a free seat), put on the waiting list, or decline with a reason | The **receiving** school's principal or admission in-charge. Never the present school, a Command or NES |
| Withdraw a request | The parent, or the present school's principal or admission in-charge |
| Issue the TC that completes the move | The present school's certificate chain, and only after the other school has accepted |
| Change the section of a child who has arrived | The receiving school's principal or admission in-charge |

## Staff chat

| Action | Who |
|---|---|
| Chat one-to-one, make groups | All active staff, across all schools, NES and the Commands. Not parents |
| Read a conversation | Its members only, and only from when they joined. The server cannot read any of it (end-to-end encrypted, see `CHAT.md`) |
| Add or remove members, rename, make admins | The group's admins. Automatic groups follow the staff lists and cannot be changed by hand |
| Post in NES announcements / a Command's announcements | NES officers / that Command's officers (and NES) |
| Delete a message for everyone | Its sender |

## Settings a school can change

- `attendance.taken_by`: class teacher (default) or any teacher of the class.
- `privacy.class_teacher_fee_status`: class teachers see "overdue" or "clear" (default off).
- `timetable.class_teacher_period`: the generator gives the class teacher Period 1 (default on).
- `fees.credit_use`: use a family's credit for their other dues (default) or refund it at once.
- `approval.fee_refund`: who approves refunds that do not follow a rule (default: principal).
- `fees.new_admission_from`: a new admission during the year pays from the start of the year (default) or from the quarter of joining.

## Changing a rule

Edit the table in `access.ts` and the matching row here, then add or change a case in `server/test/access.test.ts`. Tests must show both that the right people see the part and that everyone else is refused.
