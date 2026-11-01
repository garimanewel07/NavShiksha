# NavShiksha

The school system of the Navy Education Society: one system for NES, its Commands, every Navy Children School (NCS) and Navy Kindergarten (NKG), their staff and the parents. It carries the official NES and NCS emblems on screens, school websites, certificates and ID cards.
Built in milestones (see [docs/RELEASE_PLAN.md](docs/RELEASE_PLAN.md)); schools receive the complete system once, at go-live.

### What works today

| Area | Status |
|---|---|
| Organisation (NES → Command → school → campus), mergers | Working |
| Admissions with internal categories, students; moving between Navy schools as a request the other school accepts after checking seats (TC completes it; records move by themselves; each school charges only for its own time) | Working |
| Staff chat: one-to-one, groups, school staff groups, principals, NES and Command channels; photos and documents; end-to-end encrypted | Working (`docs/CHAT.md`) |
| Fees: dated rate versions, revisions with arrears, additional charges (CBSE, trips), credits and refunds; online payment (sandbox bank), receipts, double-entry ledger | Working |
| Attendance with correction window and approvals; homework; notices; calendar; student leave with approval chain | Working |
| Timetable: bell timings, breaks, special days, teacher absence and automatic cover, clash-free generator, class teacher in Period 1 | Working |
| Class teachers and co-class teachers, duties, settings (NES → Command → school), approvals inbox | Working |
| Who sees what (role + relationship + duty), tested | Working (`docs/ACCESS.md`) |
| School website builder (live: the page is the editor; click any text, photo or button to change it; empty places show what goes there; computer, tablet and phone views) and public sites; photos in banners, cards, messages and people | Working |
| Staff app on a phone: menu panel, every page fits the screen | Working |
| Parent app (phone layout) | Working |
| Library with scan desk, labels and old-ERP import (keeping existing labels); student and staff ID cards (plastic CR80 and others); certificates including the Navy CEA format, with QR verification; printer calibration | Working (`docs/PRINTING.md`) |
| Exams and results: set-up from the NES plan, date sheet, marks entry, holistic card, locking, publishing, analysis, report cards (PDF), results across schools, awards, parent Results | Working |
| Staff (entered once), payroll, income-tax returns, accounts and bank reconciliation | Working |
| Transport (four ways to follow a bus), monthly fees, PTA fee once per family | Working |
| Recruitment: NavShiksha Careers (register once, eligibility-checked applications, fees), screening a lakh of applications, email and SMS at every stage, interviews; the Common Written Test run by NES (setter schools, encrypted papers, roll numbers, admit cards, AES-256 papers to centres the day before, marks into merit) | Working (`docs/RECRUITMENT.md`) |
| Help for every user, support desk, AI assistant through a signed API that sees tickets only, fixes approved by the office or the developer; email and SMS log | Working (`docs/RECRUITMENT.md`, Help) |
| Attachments, student import/export | Server and tests done; screens not yet |
| Health, stores, gate, alumni, governance | Designed, not built |
| Real sign-in, live payment gateway, SMS/WhatsApp | Planned for production (R7) |

## Run it

Needs Node.js 22.12 or newer (Windows, macOS or Linux). Nothing else to install: the database (PostgreSQL, embedded) comes as a package. Step-by-step instructions for a new computer are in `../HOW_TO_RUN.md`.

```bash
npm run setup
```

```bash
npm run dev
```

`npm run setup` installs packages and builds the demo data (about a minute). `npm run dev` starts the API and the web app together; Ctrl+C stops both.

- Web: http://localhost:5173  ·  API: http://localhost:8787/api/v1
- `npm run seed` rebuilds `server/data/pg` from scratch with 7 schools (NKG Colaba merged into NCS Mumbai as its Kindergarten Campus), about 1,170 students, three quarters of fees and about 250 payments. It takes about a minute.
- Tests: `npm test` (190 tests, each on its own fresh database).
- Careers (public, no sign-in): http://localhost:5173/careers. On the test system the sign-in codes are shown on the screen instead of being sent.
- School websites (public, no sign-in): http://localhost:5173/s/ncs-mumbai — and `/s/ncs-vz`, `/s/ncs-kc`, `/s/ncs-ga`, `/s/ncs-pb`, `/s/ncs-dl`.

## Try each role

Sign in from the list on the login page. The test system uses demo sign-in with no password. It switches off automatically when `NODE_ENV=production`, or set `NES_DEMO_LOGIN=off`.

| User | Role | Try this |
|---|---|---|
| Cdr Anjali Verma | NES admin (academics) | Overview (Muster). Notices → send an NES circular to every school. Calendar → NES-wide holidays. Websites → open any school's builder. Audit log. Approve a fee revision drafted by someone else. |
| Mr Ramesh Iyer | NES admin (finance) | Fees → revise a rate. The draft shows who is affected; it needs a second NES admin to approve it. |
| Capt Vivek Menon | Command (WNC) | Overview limited to Western Naval Command; Command notices; school websites in the Command. |
| Mrs Lata Menon | Principal, NCS Kochi | **Transfers**: a Mumbai child asking for a seat in Class VI: check the seats per section and accept, wait-list or decline. **Chat**: set up a chat PIN, write in *Principals of the Navy schools*. |
| Mrs Sunita Rao | Principal, NCS Mumbai | **Transport**: today's runs (R1 is 12 minutes late this morning), routes and stop times, vehicles and their papers (the minibus insurance runs out soon), the Mehta family's request to move to Cuffe Parade (accept: the fee is put right by itself), put a child on a bus. **Staff → Add a member of staff**: one form for everything (person, post, classes and subjects, class, duties, pay, bank, PAN); the timetable, marks sheets, ID card, payroll, leave and chat follow, and the record shows what is still to fill in. Open anyone on **Staff** to see it all in one place; record a confirmation, renewal, transfer or leaving in the service book (leaving hands their classes back). **Staff leave** (sanction), **Payroll** (approve and lock September's run is done; October is waiting), **Pay structures** (a DA rise from July is waiting for approval: approving offers the arrears run). **Transfers**: a Kochi child asking to join Class VIII; children leaving (issue the TC once the other school accepts). **Chat** (set up a PIN; photos and documents). **Certificates** (Download: every TC by class, year, week, month or dates) (issue the CEA drafts for VIII-B together and print them), **ID cards**, **Printing** (calibrate printers, upload logo and signature), **Library**. **Approvals** (five-day leave with certificate, late attendance correction). **Class teachers** (allot, change from a date, co-class teachers; moving a teacher who has a class asks first). **Duties**, **Settings** (school values within NES limits, with history). **Timetable** → Week (real timings with breaks), **Cover** (Mr Faisal Khan is absent today: *Fill all automatically*), **School timings** (change periods and breaks from a date; class timetables follow), **Special days** (events, short days), **Generator** (build clash-free timetables from teaching loads), Proxy register. **Website** → edit, preview, publish, roll back, enquiries. Notices, Calendar, Leave, Admissions, Attendance. |
| Mrs Lakshmi Gaikwad | Helper, NCS Mumbai, and attendant of bus R1 (staff) | **My bus run**: R1 is tracked by her phone — *Start the run* shares the location (allow location) and stops are noticed by themselves; also running late, got on / got off for each child. R2 uses taps; R3 shows stop times only. |
| Mrs Shobha Kadam | Office superintendent, NCS Mumbai (staff, duty: staff records) | **Staff**, **Staff register** (mark the day), **Staff leave**; **My pay and leave** (payslips, tax regime, apply for leave). |
| Mr Prakash Shetty | Accountant, NCS Mumbai | **Accounts → Bank**: September's statement is imported and the salaries and challans are already matched; post the payment gateway's settlement, the bank charges and the interest; see the reconciliation. **Reports** (income and expenditure, balance sheet) and **Books** (bank and cash books), each as a spreadsheet. **Payroll → Income-tax returns** (24Q by quarter); Form 16 on each staff record. **Payroll**: October's draft (enter guest teachers' periods, check the points, submit to the principal); September's bank file, PF return, payslips; verify Mrs Meena Iyer's new bank account; the gardener's Diwali advance. **Pay structures**: propose components and scales. Fees, payments, receipts, ledger check (trial balance). **Fees → Revise fees**: a rise from 1 April billed as arrears with the next instalment, on a date, or spread. **Charges and trips**: CBSE registration for IX and XI (every child), the Class VIII science trip (only those who say yes, 40 places), refunds. Also the office (admission in-charge): **Certificates** (a parent's bonafide request, CEA drafts for VIII-B) and **ID cards**. |
| Mrs Kavita Joshi | TGT Hindi, librarian | **Library**: scan desk (type `NES-100001` for Aarav's card, then `MB000010`), catalogue, overdue, labels, import from the old ERP. |
| Mrs Sapna Kapoor | PGT Computer Science, class teacher X-B, website editor | Open any student: name, class, attendance and marks only. No fees, category or family phone numbers. Takes the roll only for X-B. |
| Mrs Priya Kulkarni | Teacher, class teacher VIII-B, timetable coordinator | **My day**: periods, class-teacher role, leave requests waiting. As coordinator she has **Timetable and cover** without a principal's access. Homework → set work for VIII-B (parents are notified). Leave requests → approve (attendance marks L automatically). |
| Lt Cdr Rohan Mehta | Parent of two children | **Parent app** (best on a phone-sized window): **My bus** (Aarav’s bus is 12 minutes late and about 350 m away, from the attendant’s phone: the new time at his stop, the map, the attendant’s number, the change he asked for), **Fees** → *Pay October* (a quarter in monthly parts), **Certificates** (request, download), **Library** (books borrowed). Fees → the Class VIII science trip asks for a reply (charged only on "Yes"; withdraw by the refund date to get the money back). Aarav's profile card, today, Monday's classes, homework (tick done), attendance calendar, timetable, notices, calendar, leave (apply/cancel), fees (pay), messages, notifications. Switch to Anaya. |
| PO Suresh Nair | Parent | Same app for Kavya, Class X. |
| Mrs Sunita Rao | Principal, NCS Mumbai (recruitment) | **Recruitment**: TGT Mathematics has 1,201 applications; filter (qualifying %, CTET score, experience, age, category, city, Navy connection), sort by merit, choose a few or act on everyone matching (shortlist, interview slots, email and SMS); open an application; spreadsheet. **Approvals → Fixes from the helpdesk**: a parent's date-of-birth correction proposed by the assistant, with the current and the new value. **CWT centre**: the papers arrive the day before the test. |
| Meera Nair | Job candidate (registered last year) | **NavShiksha Careers**: applications, her CWT admit card, profile kept from last year. Or register a new candidate at /careers/register. |
| Cdr Anjali Verma | NES (Common Written Test) | **Common Written Test**: Mumbai's TGT Mathematics requirement; Kochi has sent a paper (encrypted; *Paper*, *Key*, *Rate*, *Use this paper*); Delhi is still asked; roll numbers given; release (by itself 24 hours before). **Support desk** and **Email and SMS log**. |
| Mrs Lata Menon | Principal, NCS Kochi (CWT setter) | **CWT papers to set**: upload or replace the paper and key until the due date. |
| Ms Hema Pillai | NavShiksha helpdesk | **Desk**: tickets with names and numbers hidden, sorted by agent; resolutions by agent; **Agents** (keys for the AI assistant). |
| NavShiksha developer team | Developer | **Desk → Waiting for me**: the request for a hostel module waits for the developer's go-ahead. |

## Layout

```
server/
  src/db/migrations/   numbered SQL files — the data model and every consistency rule
  src/modules/         one file per business area (fees, payments, admissions, …)
  src/reference/       NES defaults: admission categories, fee bands, rates (data, not code)
  src/app.ts           HTTP routes, input validation, permission checks
  test/                behaviour tests
web/
  src/pages/           staff screens; src/pages/parent/ is the mobile app
  src/site/            public school websites (renderer) and the builder's section catalogue
docs/ARCHITECTURE.md   how to change things safely — read this before changing anything
docs/STRUCTURE.md      every migration, module, screen and test, one line each
docs/ACCESS.md         who sees what of a child, and who may do what
docs/FEES.md           how fees, arrears, charges, credits and refunds work
docs/PRINTING.md       library labels, ID cards, certificates, printer calibration, emblems
docs/CHAT.md           staff chat and how its end-to-end encryption works
docs/RELEASE_PLAN.md   milestones, build order, definition of done
scripts/dev.mjs        starts the API and web app together
```

## Not built yet

- **Sign-in:** demo only. R7 adds OTP sign-in for parents and SSO or passwords with 2FA for staff.
- **Payment gateway:** a sandbox bank that follows the real flow (signed webhook, duplicate-safe, amount checked). Going live means adding a gateway adapter and setting `NES_GATEWAY_SECRET`.
- **SMS, WhatsApp and email:** messages are recorded in the `outbox` table, but nothing sends them yet. R7 adds the sender.
- **Screens for exams, results and awards (R3):** the server, rules and tests are done; the staff and parent screens are next.
- **Payroll and accounts (R4), transport, library and operations (R5), committees and governance (R6):** designed in `../NES_Unified_ERP_Design.html` and `../NES_Staff_Payroll_Design.html`; see the release plan.
- **Database:** R1 runs embedded PostgreSQL (PGlite). For production, point `db/client.ts` at a managed PostgreSQL. The same migrations run unchanged.
