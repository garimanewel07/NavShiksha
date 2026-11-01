import { z } from 'zod';
import { ruleSchema } from './rules.js';

/**
 * Every setting a school, Command or NES can change. Adding a setting is one entry here; its
 * value is then set, inherited and dated through the Settings screen, never in code.
 * `levels` says which units may set it: NES ('society'), a Command, or a school.
 */
export type Level = 'society' | 'command' | 'school';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30.');
const int = (min: number, max: number) => z.number().int().min(min, `At least ${min}.`).max(max, `At most ${max}.`);

export const APPROVERS = ['CLASS_TEACHER', 'PRINCIPAL', 'NES_ADMIN', 'DUTY:EXAM_INCHARGE', 'DUTY:ADMISSION_INCHARGE', 'DUTY:ATTENDANCE_OFFICER', 'DUTY:TIMETABLE_COORDINATOR'] as const;
export const approvalChain = z.array(z.object({
  who: z.enum(APPROVERS),
  label: z.string().trim().min(2).max(40),
  when: ruleSchema.optional(),
})).min(1).max(5).refine((steps) => steps.some((s) => !s.when), 'At least one step must always apply, so every request has an approver.');

export interface SettingDef {
  key: string; category: string; label: string; help: string;
  kind: 'int' | 'bool' | 'time' | 'choice' | 'days' | 'chain' | 'text';
  options?: [string, string][];
  schema: z.ZodTypeAny;
  default: unknown;
  levels: Level[];
}

export const SETTINGS: SettingDef[] = [
  // Exams
  { key: 'exams.moderation_required', category: 'Exams and results', label: 'Marks are moderated before locking', help: 'Each subject teacher submits their class’s marks; the exam in-charge moderates every sheet before the marks can be locked.', kind: 'bool', schema: z.boolean(), default: false, levels: ['society', 'command', 'school'] },
  // Help and support
  { key: 'support.ai_assistant', category: 'Help and support', label: 'The AI assistant works on tickets', help: 'Off: the helpdesk handles every ticket by hand. On: the AI assistant also sorts faults and wrong records and proposes fixes, which the school office or the developer still approves. It never sees school records or writes to users.',
    kind: 'bool', schema: z.boolean(), default: false, levels: ['society'] },
  // Timetable and cover
  { key: 'timetable.max_proxy_day', category: 'Timetable and cover', label: 'Most cover lessons per teacher per day', help: 'Automatic cover never goes beyond this.', kind: 'int', schema: int(0, 8), default: 2, levels: ['society', 'command', 'school'] },
  { key: 'timetable.max_proxy_week', category: 'Timetable and cover', label: 'Most cover lessons per teacher per week', help: 'Keeps cover fair across the week.', kind: 'int', schema: int(0, 30), default: 6, levels: ['society', 'command', 'school'] },
  { key: 'timetable.max_periods_day', category: 'Timetable and cover', label: 'Most periods per teacher per day', help: 'Includes cover. Used by cover and the timetable generator.', kind: 'int', schema: int(1, 12), default: 7, levels: ['society', 'command', 'school'] },
  { key: 'timetable.class_teacher_period', category: 'Timetable and cover', label: 'Class teacher takes the first period', help: 'The generator gives each class teacher Period 1 with their own class every day, so the roll is taken by the class teacher.', kind: 'choice',
    options: [['FIRST', 'Yes, Period 1 every day'], ['NONE', 'No']], schema: z.enum(['FIRST', 'NONE']), default: 'FIRST', levels: ['society', 'command', 'school'] },
  // Attendance
  { key: 'attendance.taken_by', category: 'Attendance', label: 'Who takes the daily roll', help: 'Class teacher (and co-class teacher when away), or any teacher who teaches the class.', kind: 'choice',
    options: [['CLASS_TEACHER', 'Class teacher'], ['ANY_TEACHER', 'Any teacher of the class']], schema: z.enum(['CLASS_TEACHER', 'ANY_TEACHER']), default: 'CLASS_TEACHER', levels: ['society', 'command', 'school'] },
  { key: 'attendance.correction_days', category: 'Attendance', label: 'Days a teacher can correct attendance', help: 'After this, corrections need the principal’s approval. 0 means the same day only.', kind: 'int', schema: int(0, 30), default: 2, levels: ['society', 'command', 'school'] },
  { key: 'attendance.min_percent', category: 'Attendance', label: 'Minimum attendance', help: 'Below this, the child is flagged (CBSE requires 75% for board exams).', kind: 'int', schema: int(50, 100), default: 75, levels: ['society', 'command', 'school'] },
  { key: 'attendance.warn_percent', category: 'Attendance', label: 'Early-warning level', help: 'Class teacher and parent are alerted when attendance falls below this.', kind: 'int', schema: int(50, 100), default: 80, levels: ['society', 'command', 'school'] },
  { key: 'attendance.reminder_time', category: 'Attendance', label: 'Remind class teachers if the roll is not taken by', help: 'A reminder goes to the class teacher at this time.', kind: 'time', schema: hhmm, default: '09:30', levels: ['society', 'command', 'school'] },
  { key: 'approval.attendance_correction', category: 'Attendance', label: 'Who approves attendance corrections after the window', help: 'Corrections to older attendance need these approvals.', kind: 'chain', schema: approvalChain,
    default: [{ who: 'PRINCIPAL', label: 'Principal' }], levels: ['society', 'command', 'school'] },
  // Homework
  { key: 'homework.max_due_per_day', category: 'Homework', label: 'Most homework due on one day, per class', help: 'Teachers are warned before setting more.', kind: 'int', schema: int(1, 10), default: 3, levels: ['society', 'command', 'school'] },
  { key: 'homework.digest', category: 'Homework', label: 'Send parents one evening summary instead of an alert per homework', help: 'Reduces notifications.', kind: 'bool', schema: z.boolean(), default: false, levels: ['society', 'command', 'school'] },
  // Leave
  { key: 'leave.certificate_after_days', category: 'Student leave', label: 'Medical certificate needed for leave longer than', help: 'Number of days. Longer leave cannot be approved until the parent uploads a certificate.', kind: 'int', schema: int(1, 30), default: 3, levels: ['society', 'command', 'school'] },
  { key: 'approval.student_leave', category: 'Student leave', label: 'Who approves student leave', help: 'Steps in order. A step can apply only to longer leave.', kind: 'chain', schema: approvalChain,
    default: [{ who: 'CLASS_TEACHER', label: 'Class teacher' }, { who: 'PRINCIPAL', label: 'Principal', when: { gte: ['days', 4] } }], levels: ['society', 'command', 'school'] },
  // Fees
  { key: 'fees.credit_use', category: 'Fees', label: 'When a family has a credit', help: 'A credit arises when a paid charge is withdrawn or cancelled, or a fee is reduced after payment.', kind: 'choice',
    options: [['ADJUST', 'Use it for their other dues, keep the rest for the next instalment'], ['REFUND', 'Refund it at once']], schema: z.enum(['ADJUST', 'REFUND']), default: 'ADJUST', levels: ['society', 'command', 'school'] },
  { key: 'fees.pta_amount', category: 'Fees', label: 'PTA fee per family (₹)', help: 'Charged to one child of each family (the eldest at the school), with the first bill. Brothers and sisters do not pay it again. 0 for none.', kind: 'int', schema: int(0, 100000), default: 0, levels: ['society', 'command', 'school'] },
  { key: 'fees.pta_frequency', category: 'Fees', label: 'PTA fee is paid', help: 'Once a year by each family, or once only for as long as the family has a child at the school.', kind: 'choice',
    options: [['YEARLY', 'Once a year per family'], ['ONCE', 'Once only per family']], schema: z.enum(['YEARLY', 'ONCE']), default: 'YEARLY', levels: ['society', 'command', 'school'] },
  { key: 'fees.monthly_parts', category: 'Fees', label: 'Parents may pay a quarter in monthly parts', help: 'The parent app offers “pay this month’s part” (a third of the quarter each month) as well as paying in full. The instalment’s due date stays as it is.', kind: 'bool', schema: z.boolean(), default: true, levels: ['society', 'command', 'school'] },
  { key: 'fees.pay_whole_year', category: 'Fees', label: 'Parents may pay the whole year at once', help: 'The parent app offers to bill the rest of the year’s instalments now so they can be paid together. Each instalment is priced exactly as it would be when billed later.', kind: 'bool', schema: z.boolean(), default: true, levels: ['society', 'command', 'school'] },
  { key: 'fees.monthly_due_day', category: 'Fees', label: 'Day of the month monthly fees are due', help: 'Used when the school bills monthly.', kind: 'int', schema: int(1, 28), default: 10, levels: ['society', 'command', 'school'] },
  { key: 'fees.new_admission_from', category: 'Fees', label: 'A new admission during the year pays from', help: 'For a child joining from outside NES. A child moving from another NES school always pays each school for its own time.', kind: 'choice',
    options: [['YEAR_START', 'The start of the academic year (earlier quarters too)'], ['JOINING_QUARTER', 'The quarter in which the child joins']], schema: z.enum(['YEAR_START', 'JOINING_QUARTER']), default: 'YEAR_START', levels: ['society', 'command', 'school'] },
  { key: 'approval.fee_refund', category: 'Fees', label: 'Who approves refunds', help: 'Refunds that follow a rule (a cancelled trip, a withdrawal before the refund date) need no approval. Every other refund does.', kind: 'chain', schema: approvalChain,
    default: [{ who: 'PRINCIPAL', label: 'Principal' }], levels: ['society', 'command', 'school'] },
  // Payroll (each school manages its own salaries)
  { key: 'payroll.pt_state', category: 'Payroll', label: 'State for professional tax', help: 'The state whose professional tax applies to the school’s staff. Delhi and the Andaman and Nicobar Islands levy none.', kind: 'choice',
    options: [['MH', 'Maharashtra'], ['KL', 'Kerala'], ['AP', 'Andhra Pradesh'], ['GA', 'Goa'], ['DL', 'Delhi'], ['AN', 'Andaman and Nicobar Islands'], ['TN', 'Tamil Nadu'], ['KA', 'Karnataka'], ['GJ', 'Gujarat'], ['WB', 'West Bengal'], ['OD', 'Odisha']],
    schema: z.enum(['MH', 'KL', 'AP', 'GA', 'DL', 'AN', 'TN', 'KA', 'GJ', 'WB', 'OD']), default: 'DL', levels: ['school'] },
  { key: 'payroll.bank_cooling_days', category: 'Payroll', label: 'Days before a new bank account is paid', help: 'A changed bank account is used for salary only after it has been verified for this many days, so a fraudulent change can be caught.', kind: 'int', schema: int(0, 15), default: 3, levels: ['society', 'command', 'school'] },
  { key: 'payroll.change_alert_pct', category: 'Payroll', label: 'Flag a change in net pay above (%)', help: 'Payroll checks flag anyone whose net pay moved by more than this from last month, for the principal to see before approving.', kind: 'int', schema: int(1, 100), default: 10, levels: ['society', 'command', 'school'] },
  // Transport
  { key: 'transport.month_charged_if_used_by', category: 'Transport', label: 'A month’s transport is charged if the bus is used by this day', help: 'A child who starts after this day of the month pays from the next month; one who stops before it does not pay for that month.', kind: 'int', schema: int(1, 28), default: 15, levels: ['society', 'command', 'school'] },
  { key: 'transport.delay_alert_min', category: 'Transport', label: 'Tell parents when the bus is late by (minutes)', help: 'Parents at the stops still to come are told the revised time when the bus is this late, and again if it gets later.', kind: 'int', schema: int(5, 60), default: 10, levels: ['society', 'command', 'school'] },
  // Library
  { key: 'library.loan_days_student', category: 'Library', label: 'Days a student may keep a book', help: 'The due date is set this many days after issue.', kind: 'int', schema: int(1, 60), default: 14, levels: ['society', 'command', 'school'] },
  { key: 'library.loan_days_staff', category: 'Library', label: 'Days a staff member may keep a book', help: 'The due date is set this many days after issue.', kind: 'int', schema: int(1, 120), default: 30, levels: ['society', 'command', 'school'] },
  { key: 'library.max_books_student', category: 'Library', label: 'Books a student may hold at once', help: 'Issue is refused beyond this.', kind: 'int', schema: int(1, 10), default: 2, levels: ['society', 'command', 'school'] },
  { key: 'library.max_books_staff', category: 'Library', label: 'Books a staff member may hold at once', help: 'Issue is refused beyond this.', kind: 'int', schema: int(1, 30), default: 5, levels: ['society', 'command', 'school'] },
  { key: 'library.max_renewals', category: 'Library', label: 'Times a loan can be renewed', help: 'Each renewal starts a new loan period from that day.', kind: 'int', schema: int(0, 5), default: 1, levels: ['society', 'command', 'school'] },
  { key: 'library.fine_per_day', category: 'Library', label: 'Fine per day late (rupees)', help: 'Billed to the parent with the school fees. 0 means no fines.', kind: 'int', schema: int(0, 50), default: 1, levels: ['society', 'command', 'school'] },
  { key: 'library.block_when_overdue', category: 'Library', label: 'No new books while one is overdue', help: 'A borrower with an overdue book must return it before borrowing another.', kind: 'bool', schema: z.boolean(), default: true, levels: ['society', 'command', 'school'] },
  // Certificates
  { key: 'certificates.letterhead', category: 'Certificates', label: 'Certificate paper', help: 'Plain paper prints the school heading; pre-printed letterhead leaves the top of the page blank.', kind: 'choice',
    options: [['PLAIN', 'Plain paper (heading printed)'], ['PREPRINTED', 'Pre-printed letterhead']], schema: z.enum(['PLAIN', 'PREPRINTED']), default: 'PLAIN', levels: ['society', 'command', 'school'] },
  { key: 'certificates.letterhead_top_mm', category: 'Certificates', label: 'Space left for the letterhead (mm)', help: 'Measured from the top edge of the paper to just below the printed heading.', kind: 'int', schema: int(20, 100), default: 45, levels: ['school'] },
  { key: 'certificates.cea_authority', category: 'Certificates', label: 'Authority printed on CEA certificates', help: 'The orders under which the consolidated CEA certificate is issued. Change it when a new order comes out.', kind: 'text',
    schema: z.string().trim().min(10).max(400), default: '(Auth: MoD Letter No.1(23) 2017/D/(Pay/Services) dated 15 Sep 2017 and DoP&T Order No. A-27012/02/2017-Estt.(AL) dated 16 Aug 2017, and IHQ MoD (N)/DPA Letter No. PA/4202/01 dated 06 Aug 2018)',
    levels: ['society'] },
  { key: 'certificates.tc_needs_no_dues', category: 'Certificates', label: 'A transfer certificate needs all dues paid and books returned', help: 'The certificate cannot be issued while fees are due or a library book is out.', kind: 'bool', schema: z.boolean(), default: true, levels: ['society', 'command', 'school'] },
  { key: 'approval.certificate', category: 'Certificates', label: 'Who approves certificates', help: 'Bonafide, character, study, fee paid and CEA certificates.', kind: 'chain', schema: approvalChain,
    default: [{ who: 'PRINCIPAL', label: 'Principal' }], levels: ['society', 'command', 'school'] },
  { key: 'approval.certificate_tc', category: 'Certificates', label: 'Who approves transfer certificates', help: 'The class teacher confirms conduct and attendance, then the principal signs.', kind: 'chain', schema: approvalChain,
    default: [{ who: 'CLASS_TEACHER', label: 'Class teacher' }, { who: 'PRINCIPAL', label: 'Principal' }], levels: ['society', 'command', 'school'] },
  // Privacy
  { key: 'privacy.class_teacher_fee_status', category: 'Privacy', label: 'Class teachers can see whether a child’s fees are overdue', help: 'Only “overdue” or “clear”, never amounts or payments. Fees stay with the accountant and principal.', kind: 'bool',
    schema: z.boolean(), default: false, levels: ['society', 'command', 'school'] },
  // Calendar
  { key: 'calendar.working_saturdays', category: 'Calendar', label: 'Working Saturdays of the month', help: 'For example 1st and 3rd. Other Saturdays are holidays.', kind: 'days',
    schema: z.array(int(1, 5)).max(5), default: [1, 3], levels: ['society', 'command', 'school'] },
];

export const SETTING = new Map(SETTINGS.map((s) => [s.key, s]));
