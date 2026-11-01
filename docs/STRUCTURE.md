# Structure

Every file that matters, one line each. Read `ARCHITECTURE.md` for the rules about where a change belongs, `ACCESS.md` for permissions, `FEES.md` for money and `CHAT.md` for staff chat.

```
nes-erp/
  package.json         workspaces (server, web) and the commands: setup, dev, seed, test, build
  scripts/dev.mjs      starts the API (8787) and the web app (5173) together
  server/              API, database rules, demo data, tests
  web/                 staff ERP, parent app and public school websites (React)
  docs/                these documents
```

## Three layers

| Layer | Where | Holds |
|---|---|---|
| Database | `server/src/db/migrations/*.sql` | What must never be false: balances, no overlapping dates, permanent records, allowed status moves, audit log |
| Modules | `server/src/modules/*.ts` | Workflows and permissions: one file per business area |
| Routes and screens | `server/src/app.ts`, `web/src` | Input checks (zod), HTTP routes, presentation. No business rules in the browser |

## Database migrations (`server/src/db/migrations`)

Applied in order, once each, with checksums. Never edit one that has been applied; add a new file.

| File | What it adds |
|---|---|
| `0001_foundation.sql` | Extensions (btree_gist, ltree), acting-user context, hash-chained audit log, immutability helpers, outbox |
| `0002_org.sql` | NES → Command → School → Campus tree, mergers, academic years, classes, sections, users |
| `0003_people.sql` | Ranks, guardians and their dated service facts, students, enrolments (one at a time per child) |
| `0004_categories.sql` | Admission categories (Cat 1 … 4B) and fee bands as versioned, dated rule sets |
| `0005_admissions.sql` | Applications, documents, decisions; admission creates student and enrolment together |
| `0006_ledger.sql` | Chart of accounts, journals that must balance, one posting per business event |
| `0007_fees.sql` | Fee heads, plans, instalments, dated rate versions with maker-checker, concessions, permanent demand lines |
| `0008_payments.sql` | Payment orders (idempotent), gateway events (once each), payments, receipts, allocations, what is owed |
| `0009_messaging_attendance.sql` | Two-way messages with sender identity; daily attendance, locked after the day |
| `0010_performance.sql` | Indexes for the checks that run on every payment |
| `0011_school_life.sql` | Houses, subjects, timetables (no teacher in two rooms), homework, calendar, student leave, notices, notifications |
| `0012_site.sql` | School websites: draft, permanent releases, images, enquiries |
| `0013_academics.sql` | Grade bands, assessments, papers, marks, results, holistic progress card, remarks, NES awards |
| `0014_timetable_v2.sql` | Bell timings with breaks, special days, teacher absence, cover (proxy, merge, study), teaching loads |
| `0015_foundations.sql` | Settings inherited NES → Command → school, duties, approval chains, attachments, attendance correction lock |
| `0016_class_teachers.sql` | Dated class teacher and co-class teacher allotments; "class teacher time" bell slot |
| `0017_fee_changes.sql` | Bills, arrears on backdated revisions, additional charges and participants, credit transfers, refunds, payouts |
| `0018_print_library_certificates.sql` | Photos, staff details, printers and calibration, label and card stationery, school images, library (books, copies with accession numbers and label codes, loans, fines billed through fees), ID card designs and cards issued per academic year, certificates with serial register and verification codes, roll numbers, school details for headings |
| `0019_transfer_requests.sql` | Asking another Navy Children School or Navy Kindergarten for a seat: request, waiting list, acceptance into a section, completion by the TC |
| `0020_chat.sql` | Staff chat: people's public keys and PIN-sealed key backups, conversations, members, wrapped conversation keys per epoch, encrypted messages and files, read marks |
| `0021_staff_payroll.sql` | Posts and appointments, employees and service book, pay structures, components and scales, staff pay and bank accounts, payroll runs and lines, staff leave |
| `0022_one_record.sql` | One record per person: phone and email on the sign-in, date of birth, blood group and staff number on the employee (the old staff profile is now a view); guardian address; the admission form's extra details |
| `0023_accounts.sql` | Bank statements and lines (matched, posted, ignored), bank interest and charges accounts, the school's TAN |
| `0024_transport.sql` | Vehicles, crew, fares by zone, routes and stops, children on stops, parents' requests, trips, trip events, boarding |
| `0025_monthly_fees_and_tracking.sql` | Monthly instalments; how each route is followed (stop times, taps, the attendant's phone, a fitted tracker); stop positions; tracker tokens |
| `0026_family_and_pta.sql` | `family_of(child)`: the children sharing a guardian; the PTA fee (once per family) and its fund account |
| `0027_messages_tickets_support.sql` | The helpdesk, developer and candidate roles; the email and SMS queue and batches; tickets, messages and record references; support agents with signed keys, calls and nonces; fix proposals |
| `0028_recruitment.sql` | Candidates (one profile for life: education, tests, experience, documents, sign-in codes), vacancies, job applications with their sort keys and events, application fees, interview rounds and slots, the recruitment in-charge duty |
| `0029_cwt.sql` | The Common Written Test: tests, papers, requirements from schools, requests to setter schools (files encrypted at rest), centres with their protected files, the download record, roll numbers and marks |
| `0030_campus_ops.sql` | Health records, check-ups, the infirmary; incidents and drills; visitors, authorised pickup, gate passes; stores, indents, orders, receipts, stock, assets, audits, depreciation; alumni and their events |
| `0031_exams_promotion.sql` | Rooms, seating, invigilation, marks sheets and moderation, answer scripts, CBSE subjects and board results; promotion runs, class history, Class XI streams |
| `0032_holistic_cards.sql` | Holistic Progress Card templates, ratings, profiles and photos; staff signatures for cards |
| `0033_pi_and_board_results.sql` | Performance Index snapshots per school, year and class; board result uploads |
| `0034_site_media.sql` – `0036_fix_links.sql` | PDFs on school websites; candidates' thumb impression and a certificate per qualification; corrected notification links |
| `0037_system_safety.sql` | Emergency controls (kill switches) and their history; the error log behind every error reference |
| `0038_governance.sql` | Committees and members, meetings, agenda, minutes (locked once confirmed), decisions, votes, schools' action-taken reports, actions and their updates; inspection checklists, inspections, ratings, findings; one row per person per day signed in |

## Server modules (`server/src/modules`)

| Module | Does |
|---|---|
| `auth.ts` | Who is signed in (demo sign-in for testing), their scope and duties |
| `access.ts` | **Permissions**: school-wide permissions and what each person may see of a child |
| `org.ts` | Organisation tree, campuses, mergers |
| `categories.ts` | Admission category and fee band rules, worked out from service facts on a date |
| `admissions.ts` | Applications, document checks, seat offers, admission |
| `students.ts` | Search, the student record (cut to what the viewer may see), transfers, service changes |
| `fees.ts` | Raising instalments, dues by bill, fee revisions with preview, arrears and approval |
| `charges.ts` | Additional charges: CBSE registration, trips, events; replies, waiting list, excusing, cancelling, payouts |
| `refunds.ts` | Credit used against dues, refunds with approval, refund payment |
| `payments.ts` | Payment orders, sandbox bank, webhook, receipts, collections |
| `ledger.ts` | Posting journals, trial balance |
| `dashboard.ts` | The Muster dashboard for NES, Commands and schools |
| `messaging.ts` | Two-way messages between school and families |
| `attendance.ts` | Daily roll, correction window, corrections sent for approval |
| `homework.ts` | Homework, attachments, done marks |
| `notices.ts` | Notices from NES, Command or school; calendar events |
| `leave.ts` | Student leave through the approval chain, certificates |
| `notify.ts` | In-app notifications (and outbox for SMS/push later) |
| `sections.ts` | Class sections, who teaches what, a teacher's sections |
| `classTeachers.ts` | Class teacher allotment board, assign, end, acting co-class teacher |
| `timetable.ts` | Bell timings, timetables, the day view (breaks, special days, cover) |
| `cover.ts` | Teacher absence, cover board, ranking and automatic cover, special days, proxy register |
| `generator.ts` | Teaching loads and the clash-free timetable generator |
| `academics.ts` | Exams from the NES plan, papers and the date sheet, marks, locking, results, holistic card, analysis, toppers, teachers' and class teachers' lists |
| `reportCards.ts` | CBSE-style report cards as PDF for a class or a child, from published results only |
| `awards.ts` | NES award schemes, nominations, approval, payment |
| `settings.ts` | Settings with inheritance, locking, dates and history |
| `duties.ts` | Duties (timetable coordinator, exam in-charge…) and checks |
| `approvals.ts` | Approval chains: start, decide, inbox |
| `attachments.ts` | Files on homework, notices, leave and student records (type checked from the file) |
| `dataio.ts` | Spreadsheet import (all or nothing) and export (safe for Excel) |
| `site.ts` | Website builder, publishing, rollback, public site, enquiries |
| `studentApp.ts` | The parent app's home screen in one call |
| `printing.ts` | Printers and calibration pages, label and card stationery, logo / signature / stamp, photos (one or in bulk), staff details and their import |
| `library.ts` | Catalogue, accession numbers, issue / return / renew by scanning, fines and lost books billed through fees, overdue list, barcode labels, import of the old ERP's books (keeping their labels) and loans |
| `cards.ts` | Student and staff ID card designs, cards on PVC card printers, A4 or custom sheets, who has a card this academic year |
| `certificates.ts` | TC, bonafide, character, study, fee paid and CEA certificates: requests, drafts from records, approval, serials, whole-class issue, PDFs, downloads by kind, class, year and dates, public verification |
| `transfers.ts` | Moving between Navy schools: schools that teach the class with their seats, requests, accept / wait-list / decline, the move when the TC is issued (records, fees per school, refunds, trips, leave), arrivals |
| `chat.ts` | Staff chat: identities, conversations, automatic groups and channels kept in step with the staff lists, key epochs, encrypted messages and files |
| `staff.ts`, `staffLeave.ts`, `payroll.ts` | Putting a person on the staff from one form (sign-in, post, classes, pay, bank, leave, chat), the service book, hand-over on leaving; staff leave; payroll runs, arrears, final settlement, bank file, PF and ESI returns, payslips, Form 16, 24Q |
| `accounts.ts` | Bank statement import and matching, posting gateway settlements, charges and interest, reconciliation, income and expenditure, balance sheet, books |
| `transport.ts` | Vehicles, crew, fares, routes and stops, children on buses and the fee each month used, requests, the day's runs, the attendant's taps and phone, trackers, the parent's My bus |
| `messages.ts` | Email and SMS templates (with DLT IDs), the queue (one or many at once), sending with retries, the log (codes and passwords hidden) |
| `support.ts` | Tickets for every user (redacted copies for agents), the desk, agents and the signed agent API, fix proposals (corrections, repairs, settings, code changes) and their approval and application |
| `recruitment.ts` | Eligibility by NES norms, candidate registration and sign-in by codes, the profile, vacancies, applying with the declaration and fee, screening by filter (one or all matching), stage messages, interviews, merit, appointment into the staff record |
| `cwt.ts` | The Common Written Test: tests, requirements, setter suggestions and requests, uploads, review and choice, roll numbers, admit cards, release of protected files (and keys after the test), centres' downloads and marks |
| `health.ts`, `gate.ts`, `stores.ts`, `alumni.ts` | Campus operations: health and the infirmary, safety, the gate, stores and assets, alumni |
| `exams.ts`, `promotion.ts`, `hpc.ts`, `hpcCard.ts`, `reportCards.ts`, `pi.ts`, `analytics.ts` | The exam office and CBSE results (including the CBSE text file), promotion, Holistic Progress Cards, report cards, the Performance Index, the results dashboard |
| `system.ts` | Emergency controls (kill switches), stopping all traffic, the error log |
| `governance.ts` | Committees, agenda, meetings, minutes, decisions, actions with live progress, circulars and action-taken reports, voting by circulation, the NES Conference, dashboard and search |
| `inspections.ts` | Checklists, planning (surprise visits hidden from the school), ratings and the weighted score, findings and the school's responses, the report PDF |
| `insights.ts` | Every school's figures with the network average and early warnings, a principal's own school, the MIS pack PDF |

Supporting files: `src/lib/dates.ts` (today in India time; the database uses the same time zone), `src/lib/brand.ts` (the name NavShiksha and the official emblems in `src/reference/brand/`), `src/lib/pdf.ts` (drawing PDFs in millimetres with printer calibration, Code 128 barcodes and QR codes), `src/lib/zip.ts` (password-protected AES-256 zip files), `src/lib/reportPdf.ts` (flowing A4 reports: minutes, inspection reports, the MIS pack), `src/lib/secret.ts` (encryption of identity numbers and files at rest), `src/agent/worker.ts` (the NavShiksha Assistant: Claude working on tickets through the signed agent API), `src/app.ts` (every route), `src/server.ts` (starts the API), `src/seed.ts` (demo data), `src/lib/` (errors, money in paise, the rules language, the settings list, the website schema), `src/reference/` (NES defaults and website templates).

## Web (`web/src`)

| File | Screens |
|---|---|
| `main.tsx` | Sign-in, the staff sidebar (built from role and duties), the parent app tab bar, routes |
| `pages/Overview.tsx` | Muster dashboard |
| `pages/Admissions.tsx`, `Students.tsx`, `StudentProfile.tsx` | Applications, student search, the student record |
| `pages/Fees.tsx`, `Charges.tsx`, `Payments.tsx` | Fee rates and revisions; charges, trips and refunds; collections and receipts |
| `pages/Attendance.tsx`, `SchoolLife.tsx` | Roll; My day, homework, leave, notices, calendar, notifications |
| `pages/Timetable.tsx` | Week, cover, school timings, special days, generator, proxy register |
| `pages/School.tsx` | Class teachers, duties, settings, approvals |
| `pages/Library.tsx` | Scan desk, catalogue, overdue, labels, import from the old ERP |
| `pages/Cards.tsx` | ID card design and printing, photos, staff details |
| `pages/Certificates.tsx` | Certificate register, drafts, approvals, whole-class issue, printing |
| `pages/Printing.tsx` | Printers and calibration, stationery, school images |
| `pages/Incoming.tsx` | Transfers: requests to join (seats, accept, wait-list, decline), children leaving, children who joined |
| `pages/Chat.tsx`, `lib/chatCrypto.ts`, `lib/chatStore.ts` | Staff chat; the end-to-end encryption (WebCrypto); the device's key store |
| `pages/Exams.tsx` | Exams list and set-up, exam detail (date sheet, marks progress, results and report cards), teachers' marks entry, the holistic card sheet, results across schools |
| `pages/Awards.tsx` | NES awards: nominate, approve, record payment, new awards |
| `pages/Website.tsx` | Website builder: the live editor (page in the middle, fields beside it), settings, photos, history, enquiries |
| `pages/Messages.tsx`, `Audit.tsx`, `Login.tsx` | Messages, website builder, audit log, sign-in |
| `pages/parent/*` | Parent app: home, homework, attendance, timetable, notices, calendar, leave, fees and trips, messages, profile |
| `pages/Staff.tsx`, `Payroll.tsx`, `Accounts.tsx`, `Transport.tsx` | Staff list, the one form, the staff record; payroll, pay structures, tax returns; bank, reports, books; transport office and My bus run |
| `pages/Recruitment.tsx` | Vacancies, the vacancy console (filters, sorts, one or all matching, messages, interviews, applications, appointment), the NES CWT console, setter schools' uploads, the CWT centre (downloads, password, marks) |
| `pages/Careers.tsx` | NavShiksha Careers: open vacancies, registration and sign-in by codes, eligibility and applying, payment, applications and admit cards, the profile |
| `pages/Help.tsx` | Help for every user and "Report a problem with this record"; the support desk, agents, fixes waiting for approval, the email and SMS log |
| `pages/Governance.tsx` | Committees and decisions: waiting for me, the decisions dashboard, committees, search; a committee, a meeting (agenda, attendance, minutes, decisions), a decision (actions, votes, schools' reports) |
| `pages/Inspections.tsx`, `pages/Insights.tsx` | Inspections and checklists, an inspection (ratings, findings, responses); network insights and a principal's own school |
| `pages/System.tsx`, `errors.tsx`, `files.tsx` | Emergency controls and the error log; error pages, the crash catcher and the maintenance screen; files kept with a record |
| `site/*` | Public school websites, and the certificate check page (`/verify/<code>`) |

## Tests (`server/test`)

Each test file builds its own fresh database. `npm test` runs all of them.

| File | Covers |
|---|---|
| `nes-transfers.test.ts` | Requests, seats, waiting list, declining, TC completing the move, fees per school, refunds, charges, new admissions, certificate downloads |
| `chat.test.ts` | Chat with real device encryption: PIN backup, one-to-one, groups and key changes, late joiners, files, automatic groups and channels, PIN reset |
| `print-library-certificates.test.ts` | Library and old-ERP import, labels, printers, ID cards in every size and layout, photos, staff import, every certificate flow |
| `access.test.ts` | Who sees what of a child; duties; class teachers; roll; Period 1 in the generator |
| `fee-changes.test.ts` | Backdated revisions and arrears, CBSE charge, trip with seats and waiting list, refunds, credit |
| `fees-payments.test.ts` | Pricing, revisions, payments, webhooks, receipts |
| `payroll.test.ts` | Pay structures, runs, arrears, final settlement, returns, a teacher entered once and every module following |
| `transport.test.ts`, `monthly-fees.test.ts`, `family-fees.test.ts` | The four ways to follow a bus and the fee; monthly bills and parts; the PTA fee once per family |
| `support.test.ts` | Tickets, redaction, signed agent calls, corrections approved by the office, developer review, the AI worker over HTTP, the message queue |
| `recruitment.test.ts` | Registering once, eligibility, applying, fees, a lakh of applications filtered and moved on with messages, interviews, merit, appointment, documents |
| `cwt.test.ts` | Requirements, setter suggestions, encrypted uploads, review, roll numbers, admit cards, release on time with the password by SMS (the zip opened with it), keys after the test, marks into merit |
| `governance.test.ts` | Committees and who sees them, agenda, quorum, minutes locked once confirmed, circulars and action-taken reports, live progress, voting by circulation, confidential committees, the conference; inspections; insights by role |
| `system.test.ts`, `errors.test.ts` | Kill switches and stopping all traffic; error numbers and references; permissions sent to the screens |
| `hpc.test.ts`, `pi.test.ts`, `fees-year.test.ts`, `exams-promotion.test.ts`, `campus-ops.test.ts` | Holistic cards; the PI and CBSE files; paying for the whole year; the exam office and promotion; campus operations |
| `foundations.test.ts` | Settings, duties, approval chains, attendance corrections, attachments, import/export |
| `timetable.test.ts` | Bell changes, cover, limits, generator |
| `academics.test.ts` | Exams, marks, results, analysis, awards |
| `school-life.test.ts`, `site.test.ts` | Homework, notices, leave, calendar; website builder |
| `students-admissions.test.ts`, `categories.test.ts`, `rules.test.ts`, `production-guards.test.ts` | Admissions and transfers; category rules; the rules language; production safety switches |
