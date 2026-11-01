# Architecture: change without breaking

NES rules change often: new fee rates mid-year, new admission categories, school mergers, new heads, new reports. R1 is built so these are **data changes or additive code changes**, never a rewrite. Consistency comes first: the database enforces it, not the screens.

## 1. The three layers, and where a rule belongs

| Layer | Owns | Rule of thumb |
|---|---|---|
| **PostgreSQL** (`server/src/db/migrations`) | What must *never* be false: money balances, no overlapping periods, receipts never change, a student is in one school at a time | If breaking it would corrupt records, it is a constraint or trigger here |
| **Modules** (`server/src/modules`) | Workflows: admit, transfer, revise fees, take payment | Each workflow runs in one transaction (`db.tx`) and records who did it |
| **Routes + web** (`app.ts`, `web/`) | Input shape (zod), permissions, presentation | No business rules in the browser. The amount to pay is always worked out on the server |

Because the database enforces the invariants, a bug in a module or a new integration (an SMS gateway, a bank file import) **cannot** leave the books inconsistent. The transaction fails and nothing is saved.

## 2. Data consistency guarantees

| Guarantee | How it is enforced | Where |
|---|---|---|
| Journals balance (debits = credits) | Deferred constraint trigger, checked at commit | 0006 |
| Receipts, journals, demands and messages are permanent | `forbid_change` trigger. Corrections are new rows (reversal or DIFFERENCE lines), never edits | 0006–0009 |
| A payment never allocates more than is owed | Deferred `allocation_within_due` trigger | 0008 |
| One enrolment at a time per student; no overlapping fee versions, category schemes, service facts or years | `EXCLUDE USING gist` on date ranges | 0002–0007 |
| Bills are raised once | Unique index on regular demand per enrolment × instalment × head | 0007 |
| A gateway callback is processed once | Unique gateway event id; payment orders carry an idempotency key | 0008 |
| A journal is posted once per source | Unique `(source_type, source_id)` | 0006 |
| Applications move only along allowed steps | Status-transition trigger | 0005 |
| Attendance cannot be changed after the day | Lock trigger | 0009 |
| A fee version cannot be approved by the person who drafted it | `CHECK (approved_by <> created_by)` | 0007 |
| Two people editing the same record | Every editable row has a `version` that a trigger bumps on each change. The website builder saves only `where draft_version = $loaded` and tells the losing editor to reload; other workflows are guarded by state checks (transition triggers, published-only edits). New edit screens follow the website pattern | 0001, 0012 |
| Published notices and homework are never rewritten | `withdraw_only` trigger: every column is fixed except `withdrawn_at`, which can be set once. Corrections are a new record | 0011 |
| Notifications and enquiries change only their status | `only_changes(...)` trigger names the single column that may change (`read_at`, `status`) | 0011, 0012 |
| A teacher is never in two classrooms at once | `timetable_teacher_clash` trigger checks overlapping times across every timetable in force | 0011 |
| Timetables keep their history | `EXCLUDE` on (section, valid dates); a new timetable closes the old one the day before | 0011 |
| Leave follows the rules | No overlapping pending/approved leave per child (`EXCLUDE … WHERE`); allowed transitions only (pending → approved/rejected/cancelled; approved → cancelled); approved leave becomes L in attendance | 0011 |
| Website releases are permanent | `site_release` is immutable; rollback publishes an old release again as a new version. Every block is validated (`lib/siteSchema.ts`) and links accept only site paths, anchors, https, mailto and tel | 0012 |
| Uploaded images are real images | The file signature decides the type (PNG, JPEG, WebP), never the name; 2 MB limit in the API and the database | 0012 |
| Admission categories stay internal | Parents' API responses never include `admission_category`, `category_snapshot` or fee band (tested) | students.ts, studentApp.ts |
| Every change is traceable | `audit_row` trigger writes a **hash-chained** audit log with the acting user. Tampering breaks the chain | 0001 |
| Money is exact | Integer paise everywhere, never floats | `lib/money.ts` |
| A fee rise from a past date never makes anything overdue at once | Differences on instalments already due or paid go to an arrears bill (`REV2`, or `REV2-1`, `REV2-2` when spread) with its own due date; the version keeps its arrears rule; a version replaced from its first day becomes `SUPERSEDED`, never deleted | 0017 |
| Money owed is grouped by bill | `fee_demand.bill` (generated): an instalment, a revision's arrears, or a charge (`C:<id>`); `fee_due`, allocations and refunds all work per bill and head | 0017 |
| A charged child owes exactly the charge; anyone else nothing | Deferred `fee_participant_balanced` trigger compares each child's charge lines with their status (in, withdrawn after the refund date, excused…) | 0017 |
| Charges cannot change after approval | `fee_charge_guard`: amount, classes and type are fixed once open; maker-checker on approval; allowed status moves only | 0017 |
| Never refund more than the credit | Deferred `refund_within_credit` trigger; refunds move PENDING → APPROVED → PAID and money is recorded only when paid | 0017 |
| Credit is used before it is refunded | `TRANSFER` line pairs (adding to zero) move a credit to the family's oldest dues; no journal is needed because the receivable does not change | `refunds.applyCredit` |
| Money held for others is not income | CBSE and trip collections credit liability accounts 2300 and 2310 and are paid out from them | 0017 |

Database errors are translated into plain messages in `lib/errors.ts` (unique → "already exists", exclusion → "overlaps an existing period", and so on). A constraint violation never surfaces as a 500 error.

## 2a. Entered once, used everywhere

Every fact about a person is kept in one place and every module reads it from there. Nothing is copied, so nothing can disagree.

| Fact | Kept on | Read by |
|---|---|---|
| A staff member's name, mobile, email | `app_user` | sign-in, chat, payslips, ID card |
| Dates, blood group, emergency contact, staff number, PAN, Aadhaar, UAN | `employee` (the staff record) | ID card (`staff_profile` is a read-only view), service book, payroll, PF return |
| Designation | worked out by `refreshDesignation` from the post, the subject taught and the class-teacher role | everywhere it is shown; never typed |
| Classes and subjects taught | `teaching_load` | timetable generator, marks sheets, report cards, cover |
| A child's details | `student` | certificates, ID cards, report cards, parent app |
| A family's mobile, email, address | `guardian`, shared by brothers and sisters | messages, certificates, parent app |
| A school's name, address, phone, email, TAN, affiliation | `org_unit` (Settings → School details) | website (never stored in the site), certificates, report cards, ID cards, payslips, Form 16 |
| A child's bus stop | `transport_allocation` (from a date) | the transport fee on each instalment (and the difference when it changes), the attendant's list, the boarding register, the parent app |
| Money | the journal, posted when the event happens (receipt, refund, salary, challan) | bank reconciliation matches the statement to it; reports read it; nothing is re-keyed |

Rules that follow from this:
- **One form to add a member of staff** (`staff.enrol`), in one transaction: sign-in, NES staff ID, service book, post, teaching load (and empty lessons in the timetable in force), class-teacher role, duties, pay, bank (verified by a second person), identity numbers, this year's leave and the chat groups. Anything left out appears as "still to fill in" on their record.
- **The admission form is the only place a family is entered.** On admission, every detail goes into the student and guardian records, both parents are linked, and each parent gets a sign-in.
- **Corrections are made in one place** (`staff.updateDetails`, `students.updateDetails`, `students.updateGuardian`) and show everywhere. The ID-card screen and the old-ERP import write to the same staff record.
- **Life events cascade.** A transfer or separation ends the person's class-teacher role, marks their classes as needing a teacher, covers their lessons until the timetable is re-published, ends duties, tells the principal, and leaves them a sign-in that shows only their payslips.

## 3. How to make common changes

**Fee rates go up mid-year.** Draft a new fee plan version from the Fees screen. Pick a policy:
- `FUTURE_ONLY`: only instalments not yet billed get the new rate.
- `DIFFERENCE_ON_PAID`: already-billed instalments get a DIFFERENCE demand line for the gap.

A second NES admin approves it. The old version is closed and history stays intact. No code, no migration.

**A new fee head** (for example a smart-class fee). Insert a `fee_head` row and add its rates in the next fee plan version. Ledger account 4100–4190 is chosen by the head. No code.

**Category rules change** (for example a new 3D category for Coast Guard). Publish a new `category_scheme` with the edited rules. Rules are JSON (`all`/`any`/`not`/`eq`/`in`/`gte`/…), validated by `lib/rules.ts`, and effective-dated. Applications already decided keep a `category_snapshot` of the rule that applied. No code.

**Schools merge** (NKG into NCS on paper). Record an `org_merger`. The campus is re-homed under the new school and keeps its own address, and the `ltree` path moves the whole subtree. Command scope and reports follow automatically.

**A new module** (exams, payroll, committees). Add:
1. a new numbered migration `0011_<module>.sql`, using **only additive changes** (new tables or columns, columns nullable or with defaults);
2. `modules/<module>.ts`;
3. its routes in `app.ts`, each with `requireRole` plus `assertUnitInScope`;
4. pages under `web/src/pages`;
5. tests in `server/test`.

Nothing existing is edited.

**School website content.** Schools change their own websites in the ERP (Website → Pages): add pages, add or reorder sections, edit text, upload photos, preview, publish. No developer involved. A new *type* of section is a code change in three places: `server/src/lib/siteSchema.ts` (validation), `web/src/site/spec.ts` (editor fields) and `web/src/site/SiteView.tsx` (rendering). Existing sections keep their fields.

**Notifications.** Any module notifies parents or staff with `notify.toParentsOf()` / `notify.toUsers()` inside its own transaction; the parent app and staff bell pick it up with no other change.

**A side effect** (SMS, WhatsApp, email, bank export). Write an `outbox` row in the same transaction as the business change. A separate sender reads the outbox and delivers it. If the sender is down, nothing is lost and the business transaction is not blocked.

## 4. Migration rules (non-negotiable)

1. **Never edit an applied migration.** `migrate.ts` stores a checksum and refuses to start if an old file changed. Write a new migration instead.
2. **Additive first.** To rename or reshape, use expand → migrate data → contract, across at least two releases: add the new column, backfill it, switch the code, and drop the old column later.
3. **Every new table gets** a primary key, foreign keys, CHECKs, the `audit_row` trigger, and `forbid_change` if its rows are financial records.
4. **Every money column** is `bigint` paise with `CHECK (>= 0)` or explicit sign rules.
5. **Effective-dated data** uses `daterange` plus an `EXCLUDE` constraint, not `start`/`end` columns checked in code.

## 5. Access model

The organisation is a tree: NES → Command → School → Campus. It is stored as an `ltree` path such as `nes.wnc.ncs_mb.kg`. Each staff user has a scope path; a Command officer reaches their subtree, a principal one school, a parent only their own children. Adding a new Command or school needs no code.

Scope only says *where* a person works. *What* they may see and do is decided in `server/src/modules/access.ts`, kept as data (see `docs/ACCESS.md`):

- **School-wide permissions** (`assertCan`): fees, collections, admissions, categories, dashboards, analysis, registers. Given by role, or by a duty held at that school. Working at a school never gives a teacher the fee desk.
- **Parts of a child's record** (`assertStudentAccess(db, actor, studentId, need)`): profile, contact, service, category, fees, fee status, health, attendance, academics, leave, documents. A person's grants come from their role, their relationship to the child (class teacher or co-class teacher, teaches the class) and their duties. Every endpoint that takes a student id asks for the part it returns; `students.profile` and `studentApp.overview` strip every part not granted.
- **Class teachers** are dated rows in `class_teacher` (one per class per kind, one class per teacher), read with `class_teacher_of(section, date)`. The co-class teacher acts automatically when the class teacher is absent for the day.

## 6. Production swap

| R1 (testing) | Production |
|---|---|
| PGlite (embedded PostgreSQL 18) | Managed PostgreSQL 16+ with `btree_gist` and `ltree`. Swap only `db/client.ts` to `pg`. Migrations are unchanged |
| Demo sign-in | OTP for parents, SSO or password + 2FA for staff. Demo sign-in is refused when `NODE_ENV=production` |
| Sandbox bank | Gateway adapter (Razorpay, PayU or SBI ePay). `NES_GATEWAY_SECRET` is required; the server refuses the sandbox secret in production |
| Outbox not sent | Sender worker for SMS, WhatsApp and email |

## 7. Before every release

- `npm test`: the behaviour tests, including the database guarantees. Each test runs on a fresh database.
- `npx tsc --noEmit` in `server` and `web`.
- `npm audit`: zero known vulnerabilities.
- Seed and click through every role in the README.
