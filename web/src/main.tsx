import { StrictMode, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import './styles.css';
import { hasDuty, session, setSession, type User } from './api';
import { Icon, ThemeSwitch, ToastHost, initials, useLoad, useSchools } from './ui';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Admissions from './pages/Admissions';
import Incoming from './pages/Incoming';
import Chat from './pages/Chat';
import { AcrossSchools, CardSheet, ExamDetail, Exams, MarksSheet, Marking } from './pages/Exams';
import Awards from './pages/Awards';
import Students from './pages/Students';
import StudentProfile from './pages/StudentProfile';
import Fees from './pages/Fees';
import Payments from './pages/Payments';
import Messages from './pages/Messages';
import Attendance from './pages/Attendance';
import Audit from './pages/Audit';
import Website, { Websites } from './pages/Website';
import { CalendarPage, Homework, LeaveRequests, MyDay, Notices, StaffNotifications } from './pages/SchoolLife';
import Timetable from './pages/Timetable';
import { Approvals, ClassTeachers, Duties, Settings } from './pages/School';
import Charges from './pages/Charges';
import ParentHome, { P, Svg } from './pages/parent/ParentHome';
import ParentPay from './pages/parent/ParentPay';
import ParentMessages from './pages/parent/ParentMessages';
import { ParentAttendance, ParentBus, ParentCalendar, ParentCertificates, ParentHomework, ParentLeave, ParentLibrary, ParentNotices, ParentNotifications, ParentProfile, ParentResults, ParentTimetable } from './pages/parent/ParentModules';
import PublicSite from './site/PublicSite';
import Verify from './site/Verify';
import Library from './pages/Library';
import Cards from './pages/Cards';
import Certificates from './pages/Certificates';
import Printing from './pages/Printing';
import { PayOverview, PayStructures, Payroll, PayrollRun } from './pages/Payroll';
import { MyWork, StaffLeaveDesk, StaffList, StaffProfile, StaffRegister } from './pages/Staff';
import Accounts from './pages/Accounts';
import FinanceHome from './pages/FinanceHome';
import StaffHome from './pages/StaffHome';
import Transport, { BusRun } from './pages/Transport';
import Help, { Agents, Desk, MessageLog } from './pages/Help';
import Careers from './pages/Careers';
import { CwtCentre, CwtCycle, CwtCycles, CwtSetter, Recruitment, VacancyConsole } from './pages/Recruitment';
import { Health, Safety } from './pages/Health';
import { Board, MyInvigilation, Promotion } from './pages/ExamOffice';
import { Gate, GatePasses } from './pages/Gate';
import { IndentList, Stores } from './pages/Stores';
import { AlumniDesk, AlumniPortal } from './pages/Alumni';
import { ParentAboutMe, ParentGatePass, ParentHealth, ParentStreams } from './pages/parent/ParentCare';
import { HolisticSheet, HpcTemplates } from './pages/Holistic';
import { ResultsDashboard } from './pages/ResultsDashboard';
import { SchoolPi } from './pages/Pi';
import SystemControls from './pages/System';
import { CommitteePage, DecisionPage, Governance, MeetingPage } from './pages/Governance';
import { InspectionPage, Inspections } from './pages/Inspections';
import { Insights } from './pages/Insights';
import { ErrorBoundary, NotFound, SystemGate } from './errors';

const ICON: Record<string, string> = {
  overview: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 7h6V4h-6z', day: 'M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5L19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5L19 5M12 8a4 4 0 100 8 4 4 0 000-8z',
  students: 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6', admissions: 'M9 4h6l1 3H8zM6 7h12v14H6zM9 12h6M9 16h4',
  attendance: P.attendance, homework: P.homework, timetable: P.timetable, leave: P.leave, fees: P.fees, payments: 'M4 7h16v10H4zM8 12h.01M16 12h.01M12 10a2 2 0 100 4 2 2 0 000-4z',
  messages: P.messages, notices: P.notices, calendar: P.calendar, website: P.website, audit: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  approvals: 'M9 12l2 2 4-4M5 4h14v16H5z', library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.8-1 3 15.4-3.8 1z', cards: 'M3 6h18v12H3zM7 10h4v5H7zM14 10h4M14 13h4',
  certificates: 'M5 3h14v12H5zM8 7h8M8 10h5M9 15l-1 6 4-2 4 2-1-6', printing: 'M7 8V3h10v5M5 8h14v8h-3v5H8v-5H5zM8 16h8', charges: 'M4 7h16v12H4zM8 7V5h8v2M4 12h16', classteachers: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6M17 3l2 2 3-3', duties: 'M9 5h6M9 3h6v4H9zM6 5H5v16h14V5h-1M9 13l2 2 4-4',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  staff: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 11a3 3 0 100-6M21 20c0-2.5-2-4.3-4.5-4.8',
  payroll: 'M3 6h18v12H3zM3 10h18M7 15h4M16 15h1',
  accounts: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  bus: 'M5 17V6a2 2 0 012-2h10a2 2 0 012 2v11M5 17h14M5 12h14M7 20v-3M17 20v-3',
  mypay: 'M12 3v18M16 7H10a2.5 2.5 0 000 5h4a2.5 2.5 0 010 5H8',
  exams: 'M6 3h9l4 4v14H6zM9 12l2 2 4-4M15 3v4h4',
  recruit: 'M10 11a4 4 0 100-8 4 4 0 000 8zM3 21c0-4 3-6 7-6 1.5 0 2.8.3 4 .8M17 14v7M13.5 17.5h7',
  cwt: 'M7 3h10v18H7zM10 7h4M10 11h4M10 15h2M4 8h3M4 16h3',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4M12 17h.01',
  log: 'M4 5h16v14H4zM4 7l8 6 8-6',
  health: 'M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10zM12 9v5M9.5 11.5h5',
  safety: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM12 8v5M12 16h.01',
  gate: 'M4 21V8l8-5 8 5v13M9 21v-6h6v6M4 12h16',
  stores: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  alumni: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5',
  award: 'M12 15a6 6 0 100-12 6 6 0 000 12zM8.5 14l-1.5 7 5-3 5 3-1.5-7',
  results: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  governance: 'M4 21h16M6 10h12M7 10v8M12 10v8M17 10v8M12 3l8 5H4z',
  inspect: 'M9 4h6v3H9zM6 6H5v15h14V6h-1M9 14l2 2 4-4',
  insights: 'M4 19h16M5 15l4-4 3 3 7-7M15 7h4v4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 4.6V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 11h.1a2 2 0 110 4z',
};
type Item = [string, string, string];
const ALL_STAFF_COMM: Item[] = [['/chat', 'Chat', 'chat'], ['/messages', 'Messages', 'messages'], ['/notices', 'Notices', 'notices'], ['/calendar', 'Calendar', 'calendar']];

const HELP: Item = ['/help', 'Help', 'help'];
const OPS: Item[] = [['/safety', 'Safety and incidents', 'safety'], ['/gate', 'Visitors', 'gate'], ['/indents', 'Indents', 'stores']];
const RECORDS: Item[] = [['/library', 'Library', 'library'], ['/cards', 'ID cards', 'cards'], ['/certificates', 'Certificates', 'certificates'], ['/printing', 'Printing', 'printing']];

/** Screens a duty adds: the admission in-charge (office) gets admissions, certificates and cards; the librarian the library. */
function dutyItems(user: User): Item[] {
  const d = (code: string) => hasDuty(user, code);
  return [
    ...(d('ADMISSION_INCHARGE') ? [['/admissions', 'Admissions', 'admissions'] as Item, ['/incoming', 'Transfers', 'students'] as Item, ['/certificates', 'Certificates', 'certificates'] as Item, ['/cards', 'ID cards', 'cards'] as Item] : []),
    ...(d('EXAM_INCHARGE') ? [['/exams', 'Exams', 'exams'] as Item, ['/board', 'Board (CBSE)', 'results'] as Item, ['/cwt-setter', 'CWT papers to set', 'cwt'] as Item] : []),
    ...(d('RECRUITMENT_INCHARGE') ? [['/recruitment', 'Recruitment', 'recruit'] as Item, ['/cwt-centre', 'CWT centre', 'cwt'] as Item] : []),
    ...(d('NURSE') ? [['/health', 'Infirmary and health', 'health'] as Item] : []),
    ...(d('GATE_SECURITY') ? [['/gate', 'Gate', 'gate'] as Item] : []),
    ...(d('STORE_KEEPER') ? [['/stores', 'Stores and assets', 'stores'] as Item] : []),
    ...(d('ALUMNI_COORDINATOR') ? [['/alumni-desk', 'Alumni', 'alumni'] as Item] : []),
    ...(d('LIBRARIAN') ? [['/library', 'Library', 'library'] as Item] : []),
    ...(d('ADMISSION_INCHARGE') || d('LIBRARIAN') ? [['/printing', 'Printing', 'printing'] as Item] : []),
    ...(d('WEBSITE_EDITOR') ? [['/website', 'Website', 'website'] as Item] : []),
    ...(d('TRANSPORT_INCHARGE') ? [['/transport', 'Transport', 'bus'] as Item] : []),
    ...(d('STAFF_RECORDS') ? [['/staff', 'Staff', 'staff'] as Item, ['/staff-register', 'Staff register', 'attendance'] as Item, ['/staff-leave', 'Staff leave', 'leave'] as Item] : []),
  ];
}

/** Committee work and inspection visits, for staff who are not NES, a Command or a principal: shown only when they have some. */
const involvement = (user: User): Item[] => [
  ...(user.governance ? [['/governance', 'Committees and actions', 'governance'] as Item] : []),
  ...(user.inspections ? [['/inspections', 'Inspections', 'inspect'] as Item] : []),
];

/** The sidebar for a person: their role's screens, plus the screens their duties give them. */
function navFor(user: User, crew = false): [string, Item[]][] {
  const d = (code: string) => hasDuty(user, code);
  const run: Item[] = crew ? [['/bus-run', 'My bus run', 'bus']] : [];
  switch (user.role) {
    case 'NES_ADMIN': return [
      ['NES', [['/', 'Overview', 'overview'], ['/students', 'Students', 'students'], ['/admissions', 'Admissions', 'admissions'], ['/approvals', 'Approvals', 'approvals'], ['/transport', 'Transport', 'bus']]],
      ['Academics', [['/results', 'Results dashboard', 'results'], ['/pi', 'Performance Index', 'results'], ['/results/exam', 'One exam across schools', 'results'], ['/hpc-templates', 'Holistic card templates', 'exams'], ['/awards', 'Awards', 'award']]],
      ['Finance', [['/fees', 'Fees', 'fees'], ['/charges', 'Charges and trips', 'charges'], ['/payments', 'Payments', 'payments'], ['/pay/overview', 'Staff and salaries', 'staff'], ['/accounts', 'Accounts', 'accounts']]],
      ['Communication', [['/chat', 'Chat', 'chat'], ['/notices', 'Notices', 'notices'], ['/calendar', 'Calendar', 'calendar']]],
      ['Records', RECORDS],
      ['Governance', [['/governance', 'Committees and decisions', 'governance'], ['/inspections', 'Inspections', 'inspect'], ['/insights', 'Insights', 'insights']]],
      ['People', [['/cwt', 'Common Written Test', 'cwt'], ['/support', 'Support desk', 'help'], ['/message-log', 'Email and SMS log', 'log']]],
      ['Campus', [['/stores', 'Stores and assets', 'stores'], ['/alumni-desk', 'Alumni', 'alumni']]],
      ['Rules', [['/settings', 'Settings', 'settings'], ['/websites', 'Websites', 'website'], ['/audit', 'Audit log', 'audit'], ['/system', 'Emergency controls', 'safety']]],
      ['Help', [HELP]],
    ];
    case 'COMMAND_OFFICER': return [
      ['Command', [['/', 'Overview', 'overview'], ['/students', 'Students', 'students'], ['/admissions', 'Admissions', 'admissions'], ['/transport', 'Transport', 'bus']]],
      ['Academics', [['/results', 'Results dashboard', 'results'], ['/pi', 'Performance Index', 'results'], ['/results/exam', 'One exam across schools', 'results'], ['/awards', 'Awards', 'award']]],
      ['Governance', [['/governance', 'Committees and decisions', 'governance'], ['/inspections', 'Inspections', 'inspect'], ['/insights', 'Insights', 'insights']]],
      ['Staff and money', [['/pay/overview', 'Staff and salaries', 'staff'], ['/accounts', 'Accounts', 'accounts']]],
      ['Communication', [['/chat', 'Chat', 'chat'], ['/notices', 'Notices', 'notices'], ['/calendar', 'Calendar', 'calendar']]],
      ['Rules', [['/settings', 'Settings', 'settings'], ['/websites', 'Websites', 'website']]],
      ['Help', [HELP]],
    ];
    case 'SCHOOL_ADMIN': return [
      ['School', [['/', 'Overview', 'overview'], ['/approvals', 'Approvals', 'approvals'], ['/admissions', 'Admissions', 'admissions'], ['/students', 'Students', 'students'], ['/incoming', 'Transfers', 'students'], ['/transport', 'Transport', 'bus']]],
      ['Classroom', [['/attendance', 'Attendance', 'attendance'], ['/homework', 'Homework', 'homework'], ['/timetable', 'Timetable', 'timetable'], ['/leave', 'Leave requests', 'leave']]],
      ['Academics', [['/exams', 'Exams and results', 'exams'], ['/marks', 'Marks and report cards', 'results'], ['/board', 'Board (CBSE)', 'results'], ['/pi', 'Performance Index', 'results'], ['/promotion', 'Promotion to next year', 'students'], ['/awards', 'Awards', 'award']]],
      ['Staff', [['/staff', 'Staff', 'staff'], ['/staff-leave', 'Staff leave', 'leave'], ['/class-teachers', 'Class teachers', 'classteachers'], ['/duties', 'Duties', 'duties']]],
      ['Recruitment', [['/recruitment', 'Vacancies and applications', 'recruit'], ['/cwt-centre', 'CWT centre', 'cwt'], ['/cwt-setter', 'CWT papers to set', 'cwt']]],
      ['Campus', [['/health', 'Health', 'health'], ['/safety', 'Safety and incidents', 'safety'], ['/gate', 'Gate and visitors', 'gate'], ['/gate-passes', 'Gate passes', 'gate'], ['/stores', 'Stores and assets', 'stores'], ['/alumni-desk', 'Alumni', 'alumni']]],
      ['Finance', [['/fees', 'Fees', 'fees'], ['/charges', 'Charges and trips', 'charges'], ['/payments', 'Payments', 'payments'], ['/payroll', 'Payroll', 'payroll'], ['/pay-structures', 'Pay structures', 'fees'], ['/accounts', 'Accounts', 'accounts']]],
      ['Governance', [['/governance', 'Committees and decisions', 'governance'], ['/inspections', 'Inspections', 'inspect'], ['/insights', 'My school against the network', 'insights']]],
      ['Communication', [...ALL_STAFF_COMM, ['/website', 'Website', 'website']]],
      ['Records', RECORDS],
      ['Rules', [['/settings', 'Settings', 'settings'], ['/message-log', 'Email and SMS log', 'log']]],
      ['Help', [HELP]],
    ];
    case 'ACCOUNTANT': return [['Finance', [['/', 'Finance today', 'overview'], ['/fees', 'Fees', 'fees'], ['/charges', 'Charges and trips', 'charges'], ['/payments', 'Payments', 'payments'], ['/accounts', 'Accounts', 'accounts'], ['/transport', 'Transport', 'bus'], ['/students', 'Students', 'students']]],
      ['Salaries', [['/payroll', 'Payroll', 'payroll'], ['/pay-structures', 'Pay structures', 'fees'], ['/staff', 'Staff', 'staff'], ['/my/pay', 'My pay and leave', 'mypay']]],
      ['Campus', [['/stores', 'Stores and suppliers', 'stores'], ...OPS.filter((o) => o[0] !== '/indents')]],
      ...(dutyItems(user).length ? [['My duties', dutyItems(user)] as [string, Item[]]] : []), ...(involvement(user).length ? [['Governance', involvement(user)] as [string, Item[]]] : []),
      ['Communication', [['/chat', 'Chat', 'chat'], ['/notices', 'Notices', 'notices'], HELP]]];
    case 'SUPPORT': case 'DEVELOPER': return [['Support', [['/', 'Desk', 'help'], ['/support/agents', 'Agents', 'staff'], ['/approvals', user.role === 'DEVELOPER' ? 'Code changes to review' : 'Fixes waiting', 'approvals'], ['/system', 'Error log', 'log']]]];
    case 'STAFF': {
      const duty = dutyItems(user);
      return [['Me', [['/', 'My work today', 'day'], ['/my/pay', 'My pay and leave', 'mypay'], ...run]], ...(duty.length ? [['My duties', duty] as [string, Item[]]] : []), ...(involvement(user).length ? [['Governance', involvement(user)] as [string, Item[]]] : []), ['School', OPS], ['Communication', [...ALL_STAFF_COMM, HELP]]];
    }
    default: {
      const duty = dutyItems(user);
      return [
        ['Today', [['/', 'My day', 'day'], ['/approvals', 'Approvals', 'approvals'], ['/gate-passes', 'Gate passes', 'gate'], ['/invigilation', 'Invigilation duties', 'exams'], ['/my/pay', 'My pay and leave', 'mypay'], ...run]],
        ['School', OPS],
        ['Classroom', [['/attendance', 'Attendance', 'attendance'], ['/homework', 'Homework', 'homework'], ['/timetable', d('TIMETABLE_COORDINATOR') ? 'Timetable and cover' : 'Timetable', 'timetable'], ['/leave', 'Leave requests', 'leave'], ['/marks', 'Marks and report cards', 'exams'], ['/charges', 'Trips and activities', 'charges']]],
        ...(duty.length ? [['My duties', duty] as [string, Item[]]] : []),
        ...(involvement(user).length ? [['Governance', involvement(user)] as [string, Item[]]] : []),
        ['Communication', [...ALL_STAFF_COMM, HELP]],
        ['Records', [['/students', 'Students', 'students']]],
      ];
    }
  }
}

function useApprovalsCount(staff = true) {
  const loc = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setTick((t) => t + 1); window.addEventListener('nes:approvals', f); return () => window.removeEventListener('nes:approvals', f); }, []);
  const { data } = useLoad<unknown[]>(staff ? '/approvals' : null, [loc.pathname, tick]);
  const fixes = useLoad<unknown[]>('/fixes/pending', [loc.pathname, tick]);
  return (data?.length ?? 0) + (fixes.data?.length ?? 0);
}

/** Unread chat messages, checked every half minute and on every page change. */
function useChatUnread(staff = true) {
  const loc = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const { data } = useLoad<{ unread: number }>(staff ? '/chat/unread' : null, [loc.pathname, tick]);
  return data?.unread ?? 0;
}

function useUnread() {
  const loc = useLocation();
  const { data } = useLoad<{ unread: number }>('/notifications', [loc.pathname]);
  return data?.unread ?? 0;
}

/** Search from the top bar: matching pages of the menu as you type, and students by name or number.
 *  Ctrl+K (⌘K on a Mac) or / puts the cursor here. */
function NavSearch({ items, students, hotkey = false }: { items: Item[]; students: boolean; hotkey?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const list = useId();
  const navigate = useNavigate();
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);
  const t = q.trim();
  const options = [
    ...(t ? items.filter(([, label]) => label.toLowerCase().includes(t.toLowerCase())).slice(0, 6).map(([to, label]) => ({ to, label, hint: 'Page' })) : []),
    ...(students && t.length >= 2 ? [{ to: `/students?q=${encodeURIComponent(t)}`, label: `Students matching “${t}”`, hint: 'Search' }] : []),
  ];
  const go = (to: string) => { setQ(''); setOpen(false); ref.current?.blur(); navigate(to); };
  return (
    <div className="navsearch">
      <Svg d="M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4" size={17} />
      <input ref={ref} type="search" value={q} placeholder={students ? 'Search students or pages' : 'Search pages'} aria-label={students ? 'Search students or pages' : 'Search pages'}
        role="combobox" aria-expanded={open && options.length > 0} aria-controls={list} aria-autocomplete="list" enterKeyHint="search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setPick(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(p + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(p - 1, 0)); }
          else if (e.key === 'Enter' && options[pick]) { e.preventDefault(); go(options[pick].to); }
          else if (e.key === 'Escape') { setQ(''); ref.current?.blur(); }
        }} />
      {hotkey && !q && <kbd aria-hidden="true">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>}
      {open && options.length > 0 && <ul id={list} role="listbox" className="navsearch-list">
        {options.map((o, i) => <li key={o.to} role="option" aria-selected={i === pick}>
          <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => go(o.to)}>{o.label}<span>{o.hint}</span></button></li>)}
      </ul>}
    </div>
  );
}

/** Menu groups open and close; each person's choice is kept on their device. With a short menu every group starts open. */
function useNavGroups(groups: [string, Item[]][], pathname: string) {
  const [pref, setPref] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('nes.nav.open') ?? '{}'); } catch { return {}; } });
  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  const here = (to: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));
  const isOpen = (title: string, items: Item[], i: number) => pref[title] ?? (i === 0 || total <= 16 || items.some(([to]) => here(to)));
  const toggle = (title: string, open: boolean) => {
    const next = { ...pref, [title]: open };
    setPref(next);
    try { localStorage.setItem('nes.nav.open', JSON.stringify(next)); } catch { /* storage unavailable: the choice lasts until the page reloads */ }
  };
  return { isOpen, toggle };
}

/** Every new page opens at the top (the browser would otherwise keep the last page's scroll). */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function StaffShell({ user: signedIn, onSignOut }: { user: User; onSignOut: () => void }) {
  // On a phone the menu is a panel opened from the header; it closes on every page change.
  const [menu, setMenu] = useState(false);
  const where = useLocation();
  useEffect(() => { setMenu(false); }, [where.pathname]);
  // Duties change during the day; the shell always works from the current record.
  const { data: me } = useLoad<User>('/me');
  const user = me ?? signedIn;
  const { data: myBuses } = useLoad<unknown[]>(['STAFF', 'TEACHER'].includes(user.role) ? '/my/bus' : null, [user.id]);
  // A screen appears once, in the first group that has it (a duty can give a screen the role already has).
  const seen = new Set<string>();
  const groups = navFor(user, (myBuses ?? []).length > 0).map(([t, items]) => [t, items.filter(([to]) => !seen.has(to) && !!seen.add(to))] as [string, Item[]]).filter(([, items]) => items.length);
  const desk = ['SUPPORT', 'DEVELOPER'].includes(user.role);
  const unread = useUnread();
  const approvalsWaiting = useApprovalsCount(!desk);
  const chatUnread = useChatUnread(!desk);
  // Support staff see their own work first: their duties, the bus they ride and the school's day-to-day pages.
  const work = user.role === 'STAFF' ? groups.filter(([t]) => t !== 'Communication').flatMap(([, items]) => items).filter(([to]) => to !== '/' && to !== '/my/pay').map(([to, label, icon]) => ({ to, label, icon: ICON[icon] })) : [];
  const home = desk ? <Desk user={user} /> : user.role === 'ACCOUNTANT' ? <FinanceHome user={user} /> : user.role === 'TEACHER' ? <MyDay user={user} /> : user.role === 'STAFF' ? <StaffHome user={user} work={work} /> : <Overview user={user} />;
  const nav = useNavGroups(groups, where.pathname);
  // A school's own staff see their school's name in the bar; NES and the Commands look after many.
  const { schools } = useSchools();
  const mySchool = !desk && schools.length === 1 ? schools[0].name.replace('Navy Children School, ', 'NCS ').replace('Naval Kindergarten, ', 'NKG ') : null;
  const pages = groups.flatMap(([, items]) => items);
  const findsStudents = pages.some(([to]) => to === '/students');
  return (
    <>
      <header className="globalnav">
        <div className="globalnav-in">
          <button className="menu-toggle" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><span /><span /><span /></button>
          <NavLink to="/" className="brand" aria-label="NavShiksha, home"><img className="brand-logo" src="/brand/navshiksha/horizontal-dark.png" alt="NavShiksha" /></NavLink>
          {mySchool && <span className="school-chip">{mySchool}</span>}
          <div className="top-search"><NavSearch items={pages} students={findsStudents} hotkey /></div>
          <span className="spacer" />
          <NavLink to="/notifications" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><Svg d={P.bell} size={19} />{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}</NavLink>
          <span className="who">
            <span className="who-name" style={{ textAlign: 'right', lineHeight: 1.2 }}><span style={{ display: 'block', fontWeight: 600 }}>{user.name}</span><span className="muted tiny">{user.designation}</span></span>
            <span className="avatar">{initials(user.name)}</span>
            <button className="linkbtn small" onClick={onSignOut}>Sign out</button>
          </span>
        </div>
      </header>
      <ScrollToTop />
      <div className="staff-body">
        {menu && <div className="menu-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
        <nav className={`sidenav${menu ? ' open' : ''}`} aria-label="Main">
          <div className="sidenav-me"><span className="avatar">{initials(user.name)}</span><span><b>{user.name}</b><span className="tiny muted" style={{ display: 'block' }}>{user.designation}</span></span></div>
          <div className="side-search"><NavSearch items={pages} students={findsStudents} /></div>
          {groups.map(([title, items], i) => {
            const open = nav.isOpen(title, items, i);
            const waiting = !open && items.some(([to]) => (to === '/approvals' && approvalsWaiting > 0) || (to === '/chat' && chatUnread > 0));
            return (
              <div key={title} style={{ display: 'contents' }}>
                <h4><button type="button" aria-expanded={open} onClick={() => nav.toggle(title, !open)}>
                  <span style={{ flex: 1 }}>{title}</span>
                  {waiting && <span className="group-dot" aria-label="Something is waiting here" />}
                  {!open && <span className="group-n">{items.length}</span>}
                  <Svg d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} size={14} />
                </button></h4>
                {open && items.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><Icon d={ICON[icon]} size={18} />{label}{to === '/approvals' && approvalsWaiting > 0 && <span className="count" aria-label={`${approvalsWaiting} waiting`}>{approvalsWaiting}</span>}{to === '/chat' && chatUnread > 0 && <span className="count" aria-label={`${chatUnread} unread`}>{chatUnread > 99 ? '99+' : chatUnread}</span>}</NavLink>)}
              </div>);
          })}
          <ThemeSwitch />
        </nav>
        <div className="staff-main">
          <ErrorBoundary resetKey={where.pathname}>
          <Routes>
            <Route path="/" element={home} />
            <Route path="/admissions" element={<Admissions user={user} />} />
            <Route path="/incoming" element={<Incoming user={user} />} />
            <Route path="/students" element={<Students />} />
            <Route path="/students/:id" element={<StudentProfile user={user} />} />
            <Route path="/fees" element={<Fees user={user} />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/exams" element={<Exams user={user} />} />
            <Route path="/exams/:id" element={<ExamDetail user={user} />} />
            <Route path="/marks" element={<Marking user={user} />} />
            <Route path="/marks/:id/:sectionId/card" element={<CardSheet />} />
            <Route path="/marks/:id/:sectionId/holistic" element={<HolisticSheet />} />
            <Route path="/hpc-templates" element={<HpcTemplates />} />
            <Route path="/marks/:id/:sectionId/:subject" element={<MarksSheet />} />
            <Route path="/results" element={<ResultsDashboard />} />
            <Route path="/results/exam" element={<AcrossSchools />} />
            <Route path="/pi" element={<SchoolPi user={user} />} />
            <Route path="/awards" element={<Awards user={user} />} />
            <Route path="/chat" element={<Chat user={user} />} />
            <Route path="/chat/:id" element={<Chat user={user} />} />
            <Route path="/messages" element={<Messages user={user} />} />
            <Route path="/messages/:id" element={<Messages user={user} />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/homework" element={<Homework />} />
            <Route path="/timetable" element={<Timetable user={user} />} />
            <Route path="/leave" element={<LeaveRequests user={user} />} />
            <Route path="/notices" element={<Notices user={user} />} />
            <Route path="/calendar" element={<CalendarPage user={user} />} />
            <Route path="/notifications" element={<StaffNotifications />} />
            <Route path="/website" element={<Website user={user} />} />
            <Route path="/websites" element={<Websites user={user} />} />
            <Route path="/websites/:schoolId" element={<Website user={user} />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/approvals" element={<Approvals deskOnly={desk} />} />
            <Route path="/class-teachers" element={<ClassTeachers user={user} />} />
            <Route path="/duties" element={<Duties user={user} />} />
            <Route path="/settings" element={<Settings user={user} />} />
            <Route path="/library" element={<Library />} />
            <Route path="/cards" element={<Cards />} />
            <Route path="/certificates" element={<Certificates user={user} />} />
            <Route path="/printing" element={<Printing user={user} />} />
            <Route path="/charges" element={<Charges user={user} />} />
            <Route path="/staff" element={<StaffList user={user} />} />
            <Route path="/staff/:id" element={<StaffProfile user={user} />} />
            <Route path="/staff-register" element={<StaffRegister user={user} />} />
            <Route path="/staff-leave" element={<StaffLeaveDesk user={user} />} />
            <Route path="/my/pay" element={<MyWork user={user} />} />
            <Route path="/payroll" element={<Payroll user={user} />} />
            <Route path="/payroll/:id" element={<PayrollRun user={user} />} />
            <Route path="/pay-structures" element={<PayStructures user={user} />} />
            <Route path="/pay/overview" element={<PayOverview />} />
            <Route path="/accounts" element={<Accounts user={user} />} />
            <Route path="/transport" element={<Transport user={user} />} />
            <Route path="/bus-run" element={<BusRun />} />
            <Route path="/help" element={<Help user={user} />} />
            <Route path="/help/:number" element={<Help user={user} />} />
            <Route path="/support" element={<Desk user={user} />} />
            <Route path="/support/agents" element={<Agents user={user} />} />
            <Route path="/support/:number" element={<Desk user={user} />} />
            <Route path="/message-log" element={<MessageLog />} />
            <Route path="/recruitment" element={<Recruitment user={user} />} />
            <Route path="/recruitment/:id" element={<VacancyConsole user={user} />} />
            <Route path="/cwt" element={<CwtCycles />} />
            <Route path="/cwt/:id" element={<CwtCycle />} />
            <Route path="/cwt-setter" element={<CwtSetter />} />
            <Route path="/cwt-centre" element={<CwtCentre user={user} />} />
            <Route path="/health" element={<Health />} />
            <Route path="/safety" element={<Safety user={user} />} />
            <Route path="/gate" element={<Gate user={user} />} />
            <Route path="/gate-passes" element={<GatePasses user={user} />} />
            <Route path="/stores" element={<Stores user={user} />} />
            <Route path="/indents" element={<IndentList user={user} />} />
            <Route path="/alumni-desk" element={<AlumniDesk />} />
            <Route path="/board" element={<Board />} />
            <Route path="/promotion" element={<Promotion user={user} />} />
            <Route path="/invigilation" element={<MyInvigilation />} />
            <Route path="/system" element={<SystemControls user={user} />} />
            <Route path="/governance" element={<Governance user={user} />} />
            <Route path="/governance/committees/:id" element={<CommitteePage user={user} />} />
            <Route path="/governance/meetings/:id" element={<MeetingPage />} />
            <Route path="/governance/decisions/:id" element={<DecisionPage user={user} />} />
            <Route path="/inspections" element={<Inspections user={user} />} />
            <Route path="/inspections/:id" element={<InspectionPage />} />
            <Route path="/insights" element={<Insights user={user} />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
}

function ParentShell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const unread = useUnread();
  const where = useLocation();
  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');
  return (
    <>
      <ScrollToTop />
      <ErrorBoundary resetKey={where.pathname}>
      <Routes>
        <Route path="/" element={<ParentHome user={user} />} />
        <Route path="/homework" element={<ParentHomework />} />
        <Route path="/attendance" element={<ParentAttendance />} />
        <Route path="/timetable" element={<ParentTimetable />} />
        <Route path="/notices" element={<ParentNotices />} />
        <Route path="/notices/:id" element={<ParentNotices />} />
        <Route path="/calendar" element={<ParentCalendar />} />
        <Route path="/leave" element={<ParentLeave />} />
        <Route path="/fees" element={<ParentPay />} />
        <Route path="/pay" element={<Navigate to="/fees" />} />
        <Route path="/messages" element={<ParentMessages />} />
        <Route path="/messages/:id" element={<ParentMessages />} />
        <Route path="/notifications" element={<ParentNotifications />} />
        <Route path="/results" element={<ParentResults />} />
        <Route path="/about-me" element={<ParentAboutMe />} />
        <Route path="/library" element={<ParentLibrary />} />
        <Route path="/bus" element={<ParentBus />} />
        <Route path="/health" element={<ParentHealth />} />
        <Route path="/gate-pass" element={<ParentGatePass />} />
        <Route path="/streams" element={<ParentStreams />} />
        <Route path="/certificates" element={<ParentCertificates />} />
        <Route path="/profile" element={<ParentProfile user={user} onSignOut={onSignOut} />} />
        <Route path="/help" element={<Help user={user} />} />
        <Route path="/help/:number" element={<Help user={user} />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </ErrorBoundary>
      <nav className="tabbar four" aria-label="Main">
        <NavLink to="/" end className={tab}><Icon d="M3 11 12 4l9 7v9H3z" />Home</NavLink>
        <NavLink to="/notifications" className={tab}><Icon d={P.bell} />{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}Alerts</NavLink>
        <NavLink to="/messages" className={tab}><Icon d={P.messages} />Messages</NavLink>
        <NavLink to="/profile" className={tab}><Icon d={P.profile} />Profile</NavLink>
      </nav>
    </>
  );
}

function App() {
  const [s, setS] = useState(session());
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();
  const signOut = () => { setSession(null); setS(null); navigate('/'); };
  // A request refused because the session ended (it expired, or NES signed everyone out): back to sign-in, saying why.
  useEffect(() => {
    const f = (e: Event) => { setS(null); setNotice(String((e as CustomEvent).detail ?? '') || 'Your session has ended. Please sign in again.'); };
    window.addEventListener('nes:signed-out', f);
    return () => window.removeEventListener('nes:signed-out', f);
  }, []);
  if (!s) return <Login notice={notice} onSignedIn={(v) => { setSession(v); setS(v); setNotice(''); navigate(v.user.role === 'CANDIDATE' ? '/careers/my' : '/'); }} />;
  if (s.user.role === 'CANDIDATE') return <Navigate to="/careers/my" />;
  if (s.user.role === 'ALUMNUS') return <Navigate to="/alumni" />;
  return s.user.role === 'PARENT' ? <ParentShell user={s.user} onSignOut={signOut} /> : <StaffShell user={s.user} onSignOut={signOut} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastHost>
        <ErrorBoundary full>
        <SystemGate>
        <Routes>
          <Route path="/s/:slug" element={<PublicSite />} />
          <Route path="/verify/:code" element={<Verify />} />
          <Route path="/careers/*" element={<Careers />} />
          <Route path="/alumni/*" element={<AlumniPortal />} />
          <Route path="/s/:slug/:page" element={<PublicSite />} />
          <Route path="*" element={<App />} />
        </Routes>
        </SystemGate>
        </ErrorBoundary>
      </ToastHost>
    </BrowserRouter>
  </StrictMode>,
);
