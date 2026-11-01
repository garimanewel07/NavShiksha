import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as support from '../src/modules/support.js';
import * as messages from '../src/modules/messages.js';
import { devLogin, loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';

/**
 * Tickets and fixes without exposing data: agents see redacted tickets through a signed API;
 * a data correction is applied only when the school office approves it; code changes and new
 * features go to the developer first.
 */

let w: World;
let app: ReturnType<typeof buildApp>;
let ai: { keyId: string; secret: string; id: string };
let developer: Actor, helpdesk: Actor;
type Fam = Awaited<ReturnType<typeof family>>;
let kid: Fam;

/** A signed agent request, as the AI worker makes it. */
async function agent(method: 'GET' | 'POST', path: string, body?: unknown, opts: { ts?: string; reuse?: { ts: string; sig: string } } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const full = `/api/v1/agent/v1${path}`;
  const ts = opts.reuse?.ts ?? opts.ts ?? String(Date.now());
  const sig = opts.reuse?.sig ?? support.sign(ai.secret, ts, method, full, text);
  const res = await app.request(full, { method, headers: { 'content-type': 'application/json', 'x-ns-key': ai.keyId, 'x-ns-timestamp': ts, 'x-ns-signature': sig }, body: method === 'GET' ? undefined : text });
  return { status: res.status, json: await res.json() as any, ts, sig };
}
async function as(actor: Actor, method: string, path: string, body?: unknown) {
  const { token } = await devLogin(w.db, actor.id);
  const res = await app.request(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
const user = async (name: string, role: string, scope: string | null) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3) returning id`, [name, role, scope])).id);

beforeAll(async () => {
  w = await makeWorld();
  app = buildApp(w.db);
  developer = await user('Dev Team', 'DEVELOPER', null);
  helpdesk = await user('Helpdesk Hema', 'SUPPORT', null);
  const a = await support.createAgent(w.db, w.admin, { name: 'NavShiksha Assistant', kind: 'AI' });
  ai = { keyId: a.keyId, secret: a.secret, id: a.id };
  await support.createAgent(w.db, w.admin, { name: 'Hema (helpdesk)', kind: 'HUMAN', userId: helpdesk.id });
  await support.setAi(w.db, w.admin, true);                                            // these tests use the AI; it is off by default
  kid = await family(w, { classCode: 'VIII' });
  await w.db.query(`update student set name = 'Ishaan Verghese' where id = $1`, [kid.studentId]);
});

describe('raising a ticket', () => {
  let number: string;
  it('fills in the module from the page, and keeps names, phones and numbers away from agents', async () => {
    const r = await support.createTicket(w.db, kid.parent, { category: 'DATA', title: 'Wrong date of birth for Ishaan', page: '/students/abc/profile',
      description: 'Ishaan Verghese has 2013-06-01 as birthday but it is 2013-07-14. Call me on 98201 23456 or mail rao@example.com. Admission no NCS-A/2026/0042.',
      refs: [{ entityType: 'STUDENT', entityId: kid.studentId, field: 'dob', correctValue: '2013-07-14' }] });
    number = r.number;
    expect(r.module).toBe('students');
    const t = await w.db.one<{ redacted_description: string; redacted_title: string }>('select redacted_title, redacted_description from ticket where number = $1', [number]);
    expect(t.redacted_title).not.toMatch(/Ishaan/);
    expect(t.redacted_description).not.toMatch(/Ishaan|Verghese|98201|rao@example|0042/);
    expect(t.redacted_description).toContain('2013-07-14');                 // dates stay: they identify nobody
    expect(t.redacted_description).toMatch(/\[NAME\].*\[PHONE\].*\[EMAIL\]/);
    // A parent cannot attach another family's child.
    const other = await family(w, { classCode: 'VIII' });
    await rejects(support.createTicket(w.db, kid.parent, { category: 'DATA', title: 'Not mine', description: 'This is someone else’s child.', refs: [{ entityType: 'STUDENT', entityId: other.studentId }] }), /./);
  });

  it('lets an agent in only with a valid, fresh, never-reused signature', async () => {
    const bad = await app.request('/api/v1/agent/v1/tickets', { headers: { 'x-ns-key': ai.keyId, 'x-ns-timestamp': String(Date.now()), 'x-ns-signature': 'ab'.repeat(32) } });
    expect(bad.status).toBe(401);
    const stale = await agent('GET', '/tickets', undefined, { ts: String(Date.now() - 10 * 60_000) });
    expect(stale.status).toBe(401);
    const ok = await agent('GET', '/tickets?waiting=1');
    expect(ok.status).toBe(200);
    expect(ok.json.map((t: any) => t.number)).toContain(number);
    const replay = await agent('GET', '/tickets?waiting=1', undefined, { reuse: { ts: ok.ts, sig: ok.sig } });
    expect(replay.status).toBe(401);
  });

  it('shows the agent the redacted ticket and an opaque record reference, never the record', async () => {
    const t = await agent('GET', `/tickets/${number}`);
    expect(t.status).toBe(200);
    expect(JSON.stringify(t.json)).not.toMatch(/Ishaan|Verghese|98201|rao@example/);
    expect(t.json.refs[0]).toMatchObject({ entity_type: 'STUDENT', userSaysWrong: 'dob', userGaveCorrectValue: 'USER_VALUE' });
    expect(t.json.refs[0].ref).toMatch(/^R[0-9A-F]{12}$/);
    expect(JSON.stringify(t.json)).not.toContain(kid.studentId);
    expect(t.json.refs[0].correctableFields).toContain('dob');
  });

  it('turns a data correction into a proposal the school office approves, and applies it through the normal rules', async () => {
    const t = await agent('GET', `/tickets/${number}`);
    const ref = t.json.refs[0].ref;
    // There is no writing to users: only working notes for the desk, which the parent never sees.
    expect((await agent('POST', `/tickets/${number}/messages`, { body: 'Hello, can you tell me more?' })).status).not.toBe(200);
    expect((await agent('POST', `/tickets/${number}/notes`, { body: 'Date of birth wrong; the parent gave the date from the certificate.' })).status).toBe(200);
    const bad = await agent('POST', `/tickets/${number}/proposals`, { kind: 'DATA_CORRECTION', ref, field: 'dob', newValue: '14/07/2013', summary: 'Correct the date of birth' });
    expect(bad.status).toBe(422);
    // The agent never sees the value the parent typed; it proposes USER_VALUE and the system puts it in.
    const p = await agent('POST', `/tickets/${number}/proposals`, { kind: 'DATA_CORRECTION', ref, field: 'dob', newValue: 'USER_VALUE', summary: 'Correct the date of birth to the date the parent gave', details: 'The parent gave the correct date.' });
    expect(p.json).toMatchObject({ status: 'PROPOSED' });
    // The class teacher cannot approve; the principal sees current and proposed values and approves.
    expect(await support.approvals(w.db, w.teacherA)).toHaveLength(0);
    await rejects(support.decideFix(w.db, w.teacherA, p.json.number, true), /office responsible/);
    const pending = await support.approvals(w.db, w.principalA) as any[];
    expect(pending[0]).toMatchObject({ number: p.json.number, record: 'Ishaan Verghese', currentValue: '2013-06-01', new_value: '2013-07-14', stage: 'DEPARTMENT' });
    const done = await support.decideFix(w.db, w.principalA, p.json.number, true, 'Checked against the birth certificate');
    expect(done.status).toBe('APPLIED');
    expect((await w.db.one<{ d: string }>('select dob::text as d from student where id = $1', [kid.studentId])).d).toBe('2013-07-14');
    const audit = await w.db.one<{ n: number }>(`select count(*)::int as n from audit_log where entity = 'student' and entity_id = $1`, [kid.studentId]);
    expect(audit.n).toBeGreaterThan(0);
    const r = await agent('POST', `/tickets/${number}/resolve`, { resolution: 'Date of birth corrected by the school office.' });
    expect(r.json.status).toBe('RESOLVED');
    // The parent sees the progress and the resolution, never the desk's notes; and is told by email if they have one.
    const mine = await support.ticket(w.db, kid.parent, number) as any;
    expect(mine.status).toBe('RESOLVED');
    expect(mine.fixes[0].status).toBe('APPLIED');
    expect(mine.notes).toBeUndefined();
    expect(JSON.stringify(mine.progress)).not.toMatch(/certificate\./);
    expect(mine.progress.map((m: any) => m.author_kind)).toEqual(mine.progress.map(() => 'SYSTEM'));
    expect(mine.progress.at(-1).body).toMatch(/^Resolved:/);
  });

  it('runs repairs that change no data, approved by the right person', async () => {
    const tk = await support.createTicket(w.db, w.principalA, { category: 'PROBLEM', title: 'Staff chat groups missing a new teacher', description: 'A teacher who joined yesterday is not in All staff.', page: '/chat' });
    const p = await agent('POST', `/tickets/${tk.number}/proposals`, { kind: 'REPAIR', action: 'RESYNC_CHAT_GROUPS', summary: 'Rebuild the staff chat groups from the staff lists' });
    expect(p.json.status).toBe('PROPOSED');
    const unknown = await agent('POST', `/tickets/${tk.number}/proposals`, { kind: 'REPAIR', action: 'DROP_TABLES', summary: 'Something dangerous' });
    expect(unknown.status).toBe(422);
    expect((await support.decideFix(w.db, w.principalA, p.json.number, true)).status).toBe('APPLIED');
  });

  it('sends code changes and new features to the developer before any work', async () => {
    const tk = await support.createTicket(w.db, w.principalA, { category: 'REQUEST', title: 'Add a hostel module', description: 'We need hostel rooms and mess billing for boarders.', page: '/' });
    await agent('POST', `/tickets/${tk.number}/triage`, { category: 'REQUEST', summary: 'New module request', needsDeveloper: true, reason: 'A new module is a product decision.' });
    expect((await w.db.one<{ status: string }>('select status from ticket where number = $1', [tk.number])).status).toBe('AWAITING_DEVELOPER');
    const blocked = await agent('POST', `/tickets/${tk.number}/proposals`, { kind: 'REPAIR', action: 'RESYNC_CHAT_GROUPS', summary: 'Try something' });
    expect(blocked.status).toBe(409);
    await rejects(support.developerDecide(w.db, w.principalA, tk.number, true, 'ok'), /developer/);
    await support.developerDecide(w.db, developer, tk.number, true, 'Planned for R5 with health and stores.');
    const code = await agent('POST', `/tickets/${tk.number}/proposals`, { kind: 'CODE_CHANGE', summary: 'Hostel rooms and mess billing module', details: 'Tables: hostel, room, allocation; mess charges billed with fees.' });
    expect(code.json.status).toBe('DEVELOPER_REVIEW');
    await rejects(support.decideFix(w.db, w.principalA, code.json.number, true), /developer reviews/);
    expect((await support.decideFix(w.db, developer, code.json.number, true, 'Accepted')).status).toBe('APPROVED');
    expect((await support.decideFix(w.db, developer, code.json.number, true, 'Released in R5')).status).toBe('APPLIED');
  });

  it('keeps the helpdesk and developer away from school data, whatever the route', async () => {
    expect((await as(helpdesk, 'GET', `/students/${kid.studentId}`)).status).toBe(403);
    expect((await as(developer, 'GET', `/schools/${w.schoolA}/staff-records`)).status).toBe(403);
    const desk = await as(helpdesk, 'GET', '/support/tickets?sort=agent');
    expect(desk.status).toBe(200);
    expect(JSON.stringify(desk.json)).not.toMatch(/Ishaan/);
    const stats = await as(helpdesk, 'GET', '/support/agent-stats');
    expect(stats.json.find((a: any) => a.name === 'NavShiksha Assistant')).toMatchObject({ resolved: 1, fixes_applied: 3 });   // the date of birth, the chat repair and the released code change
  });
});

describe('the manual workflow (the AI switched off)', () => {
  it('is the default: the AI is refused, and the helpdesk does every step by hand', async () => {
    expect(await support.setAi(w.db, w.admin, false)).toEqual({ on: false });
    await rejects(support.setAi(w.db, w.principalA, true), /NES decides/);
    const off = await agent('GET', '/tickets');
    expect(off.status).toBe(403);
    expect(off.json.error.code).toBe('ai_off');
    const other = await family(w, { classCode: 'VIII' });
    const tk = await support.createTicket(w.db, other.parent, { category: 'DATA', title: 'Wrong blood group', page: `/students/${other.studentId}`,
      description: 'The blood group shown is B+ but it is O+.', refs: [{ entityType: 'STUDENT', entityId: other.studentId, field: 'bloodGroup', correctValue: 'O+' }] });
    // The helpdesk takes it (its agent identity is made the first time), notes, sorts and proposes the fix.
    expect((await as(helpdesk, 'POST', `/support/tickets/${tk.number}/take`)).json).toEqual({ assignedTo: 'Hema (helpdesk)' });
    await as(helpdesk, 'POST', `/support/tickets/${tk.number}/note`, { body: 'Checked: the admission form says O+.' });
    await as(helpdesk, 'POST', `/support/tickets/${tk.number}/triage`, { category: 'DATA', module: 'students', severity: 'LOW', summary: 'Blood group wrong.' });
    const view = (await as(helpdesk, 'GET', `/support/tickets/${tk.number}`)).json;
    expect(view.refs[0]).toMatchObject({ userSaysWrong: 'bloodGroup', userGaveCorrectValue: true });
    expect(view.refs[0].correctableFields.bloodGroup).toBe('Blood group');
    const p = await as(helpdesk, 'POST', `/support/tickets/${tk.number}/proposals`, { kind: 'DATA_CORRECTION', ref: view.refs[0].ref, field: 'bloodGroup', newValue: 'USER_VALUE', summary: 'Correct the blood group' });
    expect(p.status).toBe(201);
    expect((await as(helpdesk, 'POST', `/support/tickets/${tk.number}/resolve`, { resolution: 'Too early' })).status).toBe(409);   // the fix still waits
    await support.decideFix(w.db, w.principalA, p.json.number, true);
    expect((await w.db.one<{ b: string }>('select blood_group as b from student where id = $1', [other.studentId])).b).toBe('O+');
    expect((await as(helpdesk, 'POST', `/support/tickets/${tk.number}/resolve`, { resolution: 'Blood group corrected by the school office.' })).json.status).toBe('RESOLVED');
    // Users cannot write on the ticket; if it is still wrong they reopen it once or twice, saying why.
    expect((await as(other.parent, 'POST', `/help/tickets/${tk.number}/reply`, { body: 'Thanks' })).status).toBe(404);
    expect((await as(other.parent, 'POST', `/help/tickets/${tk.number}/reopen`, { reason: 'The ID card still shows B+.' })).json.status).toBe('IN_PROGRESS');
    expect((await as(other.parent, 'GET', `/help/tickets/${tk.number}`)).json.progress.at(-1).body).toMatch(/Reopened/);
    // Something that is not a fault is closed with the reason, which the user sees.
    const q = await support.createTicket(w.db, w.teacherA, { category: 'PROBLEM', title: 'Cannot see other schools', description: 'I cannot see the students of NCS Bravo.', page: '/students' });
    await as(helpdesk, 'POST', `/support/tickets/${q.number}/reject`, { reason: 'Teachers see only their own school’s students; this is intended.' });
    const mine = await support.ticket(w.db, w.teacherA, q.number) as any;
    expect(mine).toMatchObject({ status: 'REJECTED', resolution: 'Teachers see only their own school’s students; this is intended.' });
    const stats = (await as(helpdesk, 'GET', '/support/agent-stats')).json;
    expect(stats.find((a: any) => a.name === 'Hema (helpdesk)' && a.resolved >= 2)).toBeTruthy();
    await support.setAi(w.db, w.admin, true);
  });
});

describe('the message centre', () => {
  it('queues emails and SMS, sends them, and retries failures', async () => {
    await w.db.tx((t) => messages.queuePair(t, 'INTERVIEW', { email: 'candidate@example.in', mobile: '+919820000001' },
      { vars: { name: 'Asha', post: 'TGT Science', school: 'NCS Alpha', round: 'Interview', date: '5 Nov 2026', time: '10:00', venue: 'Main hall', bring: 'Originals', link: 'https://x' }, context: 'RECRUITMENT' }), { actor: 'test' });
    const r = await messages.dispatch(w.db);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const sms = await w.db.one<{ body: string; status: string }>(`select body, status from outbound_message where to_address = '+919820000001'`);
    expect(sms).toMatchObject({ status: 'SENT' });
    expect(sms.body).toContain('TGT Science on 5 Nov 2026 10:00');
  });
});

describe('the AI worker', () => {
  it('signs its requests the way the server checks them, over real HTTP', async () => {
    const { serve } = await import('@hono/node-server');
    const worker = await import('../src/agent/worker.js');
    const server = await new Promise<ReturnType<typeof serve>>((ok) => { const s = serve({ fetch: app.fetch, port: 0 }, () => ok(s)); });
    const port = (server.address() as { port: number }).port;
    worker.configure({ url: `http://127.0.0.1:${port}/api/v1`, key: ai.keyId, secret: ai.secret });
    const tickets = await worker.call('GET', '/tickets') as { number: string }[];
    expect(tickets.length).toBeGreaterThan(0);
    const cat = await worker.call('GET', '/catalog') as { repairs: Record<string, unknown> };
    expect(Object.keys(cat.repairs)).toContain('RESYNC_CHAT_GROUPS');
    const docs = await worker.call('GET', '/knowledge?q=transport%20fee%20month') as { title: string }[];
    expect(docs.length).toBeGreaterThan(0);
    worker.configure({ url: `http://127.0.0.1:${port}/api/v1`, key: ai.keyId, secret: 'wrong-secret' });
    await expect(worker.call('GET', '/tickets')).rejects.toThrow(/signature/);
    server.close();
  });
});
