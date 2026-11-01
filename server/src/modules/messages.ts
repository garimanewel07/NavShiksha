import type { Db } from '../db/client.js';
import { forbidden } from '../lib/errors.js';
import type { Actor } from './auth.js';

/**
 * The message centre: every email and SMS NavShiksha sends, for every module. Messages are written
 * here first, inside the same transaction as the event that causes them (an application received,
 * an interview fixed, a ticket answered), and a dispatcher sends them, retrying with back-off, so a
 * provider outage never loses a message. Bulk sends are one INSERT … SELECT, not a loop.
 *
 * SMS in India must use templates registered on the DLT platform; each SMS template here carries
 * its DLT template ID (set at go-live) and only its {{variables}} change.
 */

export type Channel = 'EMAIL' | 'SMS';
interface Template { channel: Channel; subject?: string; body: string; dlt?: string; secret?: boolean }   // secret: a code or password, never shown in the log and wiped once sent

export const TEMPLATES: Record<string, Template> = {
  // Accounts
  OTP_SMS: { channel: 'SMS', body: 'Your NavShiksha code is {{code}}. It is valid for 10 minutes. Do not share it. - NES', dlt: 'DLT_OTP', secret: true },
  OTP_EMAIL: { channel: 'EMAIL', subject: 'Your NavShiksha code: {{code}}', body: 'Your one-time code is {{code}}. It is valid for 10 minutes.\n\nIf you did not ask for it, ignore this email.\n\nNavy Education Society', secret: true },
  CANDIDATE_REGISTERED_EMAIL: { channel: 'EMAIL', subject: 'Welcome to NavShiksha Careers, {{name}}', body: 'Dear {{name}},\n\nYour candidate registration {{candidateNo}} is complete. Keep your profile up to date; you can apply for any post at a Navy Children School or Navy Kindergarten without registering again.\n\nNavy Education Society' },
  // Recruitment
  APPLICATION_SUBMITTED_EMAIL: { channel: 'EMAIL', subject: 'Application {{applicationNo}} received: {{post}}', body: 'Dear {{name}},\n\nYour application {{applicationNo}} for {{post}} at {{school}} has been received{{feeLine}}.\n\nYou can follow it at {{link}}.\n\n{{school}}' },
  APPLICATION_SUBMITTED_SMS: { channel: 'SMS', body: 'NES: Application {{applicationNo}} for {{post}} at {{school}} received. Track at {{link}}', dlt: 'DLT_APP_RECEIVED' },
  FEE_RECEIVED_SMS: { channel: 'SMS', body: 'NES: Fee of Rs {{amount}} received for application {{applicationNo}}. Receipt {{receiptNo}}.', dlt: 'DLT_FEE_RECEIVED' },
  STAGE_EMAIL: { channel: 'EMAIL', subject: '{{post}}: {{stage}}', body: 'Dear {{name}},\n\n{{message}}\n\nApplication {{applicationNo}} · {{school}}\nFollow your application at {{link}}.' },
  STAGE_SMS: { channel: 'SMS', body: 'NES: {{stageShort}} for {{post}}, application {{applicationNo}}. Details at {{link}}', dlt: 'DLT_APP_STAGE' },
  INTERVIEW_EMAIL: { channel: 'EMAIL', subject: 'Interview: {{post}} on {{date}}', body: 'Dear {{name}},\n\nYou are invited for {{round}} for {{post}} at {{school}}.\n\nDate and time: {{date}} at {{time}}\nVenue: {{venue}}\nBring: {{bring}}\n\nPlease confirm at {{link}}.\n\n{{school}}' },
  INTERVIEW_SMS: { channel: 'SMS', body: 'NES: {{round}} for {{post}} on {{date}} {{time}} at {{venue}}. Confirm at {{link}}', dlt: 'DLT_INTERVIEW' },
  ADMIT_CARD_EMAIL: { channel: 'EMAIL', subject: 'Admit card: CWT {{cycle}}', body: 'Dear {{name}},\n\nYour admit card for the Common Written Test is ready. Roll number {{rollNo}}, centre {{centre}}, on {{date}} at {{time}}.\n\nDownload it at {{link}} and bring it with a photo ID.\n\nNavy Education Society' },
  ADMIT_CARD_SMS: { channel: 'SMS', body: 'NES: CWT admit card ready. Roll {{rollNo}}, {{centre}}, {{date}} {{time}}. Download at {{link}}', dlt: 'DLT_ADMIT_CARD' },
  CUSTOM_EMAIL: { channel: 'EMAIL', subject: '{{subject}}', body: 'Dear {{name}},\n\n{{message}}\n\n{{sender}}' },
  CUSTOM_SMS: { channel: 'SMS', body: 'NES: {{message}} - {{sender}}', dlt: 'DLT_CUSTOM_NOTICE' },
  // CWT
  CWT_PAPER_REQUEST_EMAIL: { channel: 'EMAIL', subject: 'CWT {{cycle}}: question paper requested ({{paper}})', body: 'Dear Principal,\n\nNES requests a question paper and answer key for {{paper}} for the Common Written Test {{cycle}}, by {{due}}. Please upload them in NavShiksha under CWT. They are kept encrypted and seen only by the NES CWT cell.\n\nNavy Education Society' },
  CWT_PASSWORD_SMS: { channel: 'SMS', body: 'NES CWT {{cycle}}: password for the question papers of centre {{centre}} is {{password}}. Do not share it.', dlt: 'DLT_CWT_PASSWORD', secret: true },
  CWT_RELEASED_EMAIL: { channel: 'EMAIL', subject: 'CWT {{cycle}}: question papers for {{centre}}', body: 'Dear Principal,\n\nThe question papers for your centre for {{date}} are ready to download in NavShiksha (CWT). The file is password-protected; the password has been sent to you by SMS.\n\nOpen it with 7-Zip or WinRAR (AES-256). Every download is recorded.\n\nNavy Education Society' },
  // The gate and alumni
  VISITOR_CODE_SMS: { channel: 'SMS', body: 'NES: You are expected at {{school}} on {{date}} to meet {{host}}. Show code {{code}} at the gate.', dlt: 'DLT_VISITOR_CODE', secret: true },
  ALUMNI_STATUS_EMAIL: { channel: 'EMAIL', subject: 'Your alumni registration is {{status}}', body: 'Dear {{name}},\n\nYour registration as an alumnus is {{status}}. {{note}}\n\nSign in to NavShiksha Alumni to see your school’s directory and events.' },
  ALUMNI_EVENT_EMAIL: { channel: 'EMAIL', subject: '{{school}} alumni: {{title}}', body: 'Dear {{name}},\n\n{{when}}{{body}}\n\nReply in NavShiksha Alumni.\n\n{{school}}' },
  // Support
  TICKET_UPDATE_EMAIL: { channel: 'EMAIL', subject: '{{number}} {{status}}: {{title}}', body: 'Your ticket {{number}} ("{{title}}") is {{status}}.\n\n{{note}}\n\nSee it in NavShiksha under Help.' },
};

/** Fills {{name}} placeholders. Missing values become empty, never "undefined". */
export function render(text: string, vars: Record<string, unknown>) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

export interface Send { template: string; to: string; vars: Record<string, unknown>; context: string; refType?: string; refId?: string; schoolId?: string | null; batchId?: string | null; createdBy?: string | null }

/** Puts a message in the queue (inside the caller's transaction). */
export async function queue(t: Db, m: Send) {
  const tpl = TEMPLATES[m.template];
  if (!tpl) throw new Error(`Unknown message template ${m.template}`);
  if (!m.to) return null;
  const body = render(tpl.body, m.vars);
  const r = await t.one<{ id: number }>(
    `insert into outbound_message (channel, to_address, template_code, subject, body, context, ref_type, ref_id, school_id, batch_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [tpl.channel, m.to, m.template, tpl.subject ? render(tpl.subject, m.vars) : null, tpl.channel === 'SMS' ? body.slice(0, 480) : body, m.context, m.refType ?? null, m.refId ?? null, m.schoolId ?? null, m.batchId ?? null, m.createdBy ?? null]);
  return r.id;
}

/** Both an email and an SMS from a pair of templates (`X_EMAIL`, `X_SMS`), to whichever addresses exist. */
export async function queuePair(t: Db, base: string, to: { email?: string | null; mobile?: string | null }, m: Omit<Send, 'template' | 'to'>) {
  if (to.email && TEMPLATES[`${base}_EMAIL`]) await queue(t, { ...m, template: `${base}_EMAIL`, to: to.email });
  if (to.mobile && TEMPLATES[`${base}_SMS`]) await queue(t, { ...m, template: `${base}_SMS`, to: to.mobile });
}

/**
 * Many messages at once (a shortlist, admit cards, a school's notice to a filtered set): rendered
 * here and inserted two thousand rows per statement, so a lakh of candidates takes seconds.
 */
export async function queueMany(t: Db, items: { template: string; to: string | null | undefined; vars: Record<string, unknown>; refId?: string }[],
  common: { context: string; refType?: string; schoolId?: string | null; batchId?: string | null; createdBy?: string | null }) {
  const rows = items.filter((m) => m.to).map((m) => {
    const tpl = TEMPLATES[m.template];
    if (!tpl) throw new Error(`Unknown message template ${m.template}`);
    const body = render(tpl.body, m.vars);
    return { channel: tpl.channel, to_address: m.to, template_code: m.template, subject: tpl.subject ? render(tpl.subject, m.vars) : null, body: tpl.channel === 'SMS' ? body.slice(0, 480) : body, ref_id: m.refId ?? null };
  });
  for (let i = 0; i < rows.length; i += 2000) await t.query(
    `insert into outbound_message (channel, to_address, template_code, subject, body, context, ref_type, ref_id, school_id, batch_id, created_by)
     select x.channel, x.to_address, x.template_code, x.subject, x.body, $2, $3, x.ref_id, $4, $5, $6
       from jsonb_to_recordset($1::jsonb) as x(channel text, to_address text, template_code text, subject text, body text, ref_id text)`,
    [JSON.stringify(rows.slice(i, i + 2000)), common.context, common.refType ?? null, common.schoolId ?? null, common.batchId ?? null, common.createdBy ?? null]);
  return rows.length;
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────

type Provider = (m: { channel: Channel; to: string; subject: string | null; body: string; template: string }) => Promise<string>;

/**
 * The provider. Until go-live everything goes to the sandbox (recorded as sent, visible in the
 * message log). With EMAIL_WEBHOOK_URL / SMS_WEBHOOK_URL set, messages are posted to the email
 * service and the SMS gateway (with the DLT template ID).
 */
function provider(): { name: string; send: Provider } {
  const email = process.env.EMAIL_WEBHOOK_URL, sms = process.env.SMS_WEBHOOK_URL;
  if (!email && !sms) return { name: 'sandbox', send: async () => `sbx_${Date.now().toString(36)}` };
  return {
    name: 'gateway',
    send: async (m) => {
      const url = m.channel === 'EMAIL' ? email : sms;
      if (!url) throw new Error(`No ${m.channel.toLowerCase()} provider is configured.`);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MESSAGE_GATEWAY_KEY ?? ''}` },
        body: JSON.stringify(m.channel === 'EMAIL' ? { to: m.to, subject: m.subject, text: m.body } : { to: m.to, text: m.body, dlt_template_id: TEMPLATES[m.template]?.dlt }) });
      if (!res.ok) throw new Error(`Provider answered ${res.status}`);
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      return j.id ?? 'sent';
    },
  };
}

const HIDDEN = '[hidden: contains a one-time code or password]';

/** Sends what is due, a batch at a time. Failures retry at 1, 4, 9, 16 minutes, then stop as FAILED. */
export async function dispatch(db: Db, limit = 300) {
  const due = await db.query<{ id: number; channel: Channel; to_address: string; subject: string | null; body: string; template_code: string; attempts: number }>(
    `select id, channel, to_address, subject, body, template_code, attempts from outbound_message where status = 'QUEUED' and next_attempt_at <= now() order by id limit $1`, [limit]);
  if (!due.length) return { sent: 0, failed: 0 };
  const p = provider();
  let sent = 0, failed = 0;
  for (const m of due) {
    try {
      const ref = await p.send({ channel: m.channel, to: m.to_address, subject: m.subject, body: m.body, template: m.template_code });
      await db.query(`update outbound_message set status = 'SENT', sent_at = now(), attempts = attempts + 1, provider = $2, provider_ref = $3, last_error = null,
                       body = case when $4 then $5 else body end, subject = case when $4 and subject is not null then $5 else subject end where id = $1`, [m.id, p.name, ref, !!TEMPLATES[m.template_code]?.secret, HIDDEN]);
      sent++;
    } catch (e) {
      const n = m.attempts + 1;
      await db.query(`update outbound_message set attempts = $2, last_error = $3, status = case when $2 >= 5 then 'FAILED' else 'QUEUED' end, next_attempt_at = now() + ($2 * $2) * interval '1 minute' where id = $1`,
        [m.id, n, (e as Error).message.slice(0, 300)]);
      failed++;
    }
  }
  return { sent, failed };
}

/** The message log: NES sees all; a school sees its own. */
export async function log(db: Db, actor: Actor, q: { schoolId?: string; to?: string; context?: string; status?: string; refType?: string; refId?: string; limit?: number }) {
  if (!['NES_ADMIN', 'SCHOOL_ADMIN'].includes(actor.role)) throw forbidden('The message log is for the principal and NES.');
  const schoolOnly = actor.role === 'SCHOOL_ADMIN' ? (await db.query<{ id: string }>(`select id from org_unit where kind = 'school' and path <@ $1::ltree`, [actor.scopePath])).map((s) => s.id) : null;
  const rows = await db.query<{ template_code: string; body: string; subject: string | null }>(
    `select id, channel, to_address, template_code, subject, body, context, ref_type, ref_id, status, attempts, last_error, provider, created_at, sent_at from outbound_message
      where ($1::uuid[] is null or school_id = any($1)) and ($2::uuid is null or school_id = $2) and ($3::text is null or to_address = $3) and ($4::text is null or context = $4)
        and ($5::text is null or status = $5) and ($6::text is null or ref_type = $6) and ($7::text is null or ref_id = $7)
      order by id desc limit $8`, [schoolOnly, q.schoolId ?? null, q.to ?? null, q.context ?? null, q.status ?? null, q.refType ?? null, q.refId ?? null, Math.min(q.limit ?? 200, 1000)]);
  return rows.map((r) => (TEMPLATES[r.template_code]?.secret ? { ...r, body: HIDDEN, subject: r.subject ? HIDDEN : null } : r));
}

/** Puts failed messages of a school back in the queue (a repair action). */
export async function retryFailed(t: Db, schoolId: string | null) {
  const r = await t.query(`update outbound_message set status = 'QUEUED', attempts = 0, next_attempt_at = now() where status = 'FAILED' and ($1::uuid is null or school_id = $1) returning 1`, [schoolId]);
  return r.length;
}
