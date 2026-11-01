import { beforeAll, describe, expect, it } from 'vitest';
import { loadActor, type Actor } from '../src/modules/auth.js';
import * as gov from '../src/modules/governance.js';
import * as insp from '../src/modules/inspections.js';
import * as insights from '../src/modules/insights.js';
import { makeWorld, type World } from './helpers.js';

/**
 * R6: committees, agenda, meetings, minutes, decisions with live progress and action-taken reports,
 * voting by circulation, confidential committees; inspections; insights. Who sees what is checked
 * as carefully as what happens.
 */

let w: World;
let command: Actor, principalB: Actor, teacherB: Actor;
let ec = '', meetingId = '', decisionId = '', itemId = '';
const soon = () => new Date(Date.now() + 3600_000).toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await makeWorld();
  const user = async (name: string, role: string, scope: string) =>
    loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3::ltree) returning id`, [name, role, scope])).id);
  command = await user('Command Officer West', 'COMMAND_OFFICER', 'nes.wnc');
  principalB = await user('Principal Bravo', 'SCHOOL_ADMIN', 'nes.enc.ncs_b');
  teacherB = await user('Teacher Bravo', 'TEACHER', 'nes.enc.ncs_b');
});

const nesUnit = async () => (await w.db.one<{ id: string }>(`select id from org_unit where kind = 'society'`)).id;

describe('committees', () => {
  it('NES sets up its committees; a principal cannot, and must name a chair and a convener', async () => {
    const unitId = await nesUnit();
    const members: gov.MemberInput[] = [{ userId: w.admin.id, role: 'CHAIR' }, { userId: w.finance.id, role: 'CONVENER' }, { userId: w.principalA.id, role: 'MEMBER' },
      { name: 'Cdr (Retd) Outside Member', detail: 'Nominee of the Chairman', role: 'MEMBER' }];
    await expect(gov.createCommittee(w.db, w.principalA, { unitId, kind: 'EXECUTIVE', quorum: 3, members })).rejects.toThrow(/outside|access/i);
    await expect(gov.createCommittee(w.db, w.admin, { unitId, kind: 'EXECUTIVE', quorum: 3, members: members.filter((m) => m.role !== 'CHAIR') })).rejects.toThrow(/one chair/);
    await expect(gov.createCommittee(w.db, w.admin, { unitId: w.schoolA, kind: 'EXECUTIVE', quorum: 3, members })).rejects.toThrow(/NES committee/);
    ec = (await gov.createCommittee(w.db, w.admin, { unitId, kind: 'EXECUTIVE', quorum: 3, purpose: 'Policy for all schools', members })).id;
    const c = await gov.committee(w.db, w.finance, ec);
    expect(c.members.length).toBe(4);
    expect(c.rights.run).toBe(true);
    expect((await gov.committees(w.db, w.principalA)).some((x: any) => x.id === ec)).toBe(true);   // a member
    expect((await gov.committees(w.db, principalB)).some((x: any) => x.id === ec)).toBe(false);    // not a member, not their level
    await expect(gov.committee(w.db, teacherB, ec)).rejects.toThrow(/members/);
  });

  it('a member submits an agenda item; the convener puts it on the meeting; others cannot submit', async () => {
    meetingId = (await gov.scheduleMeeting(w.db, w.finance, ec, { startsAt: soon(), venue: 'NES HQ, New Delhi' })).id;
    await expect(gov.submitItem(w.db, w.teacherA, ec, { title: 'Something' })).rejects.toThrow(/members/);
    const it = await gov.submitItem(w.db, w.principalA, ec, { title: 'Uniform for Kindergartens', details: 'Lighter summer uniform', meetingId });
    expect(it.status).toBe('SUBMITTED');
    itemId = it.id;
    await gov.triageItem(w.db, w.finance, it.id, { action: 'ACCEPT', meetingId });
    const m = await gov.meeting(w.db, w.principalA, meetingId);
    expect(m.items.map((x: any) => x.title)).toContain('Uniform for Kindergartens');
    expect(m.title).toMatch(/1st meeting/);
  });
});

describe('meetings, minutes and decisions', () => {
  it('records attendance with the quorum, and a decision with its actions and schools in one go', async () => {
    const m = await gov.meeting(w.db, w.finance, meetingId);
    const mark = (name: string): string => (m.attendance as any[]).find((a) => a.name === name).member_id;
    const r = await gov.attendance(w.db, w.finance, meetingId, [{ memberId: mark('NES Admin'), status: 'PRESENT' }, { memberId: mark('NES Finance'), status: 'PRESENT' },
      { memberId: mark('Principal Alpha'), status: 'PRESENT' }, { memberId: mark('Cdr (Retd) Outside Member'), status: 'LEAVE' }]);
    expect(r.quorumMet).toBe(true);
    const d = await gov.recordDecision(w.db, w.finance, meetingId, { agendaItemId: itemId, title: 'Summer uniform for Kindergartens', body: 'Kindergartens move to the lighter uniform from April.',
      ownerId: w.principalA.id, dueOn: inDays(60), schoolIds: [w.schoolA], actions: [{ title: 'Order samples', ownerId: w.teacherA.id, dueOn: inDays(20) }] });
    decisionId = d.id;
    expect(d.ref).toMatch(/^EC\/\d{4}-\d{2}\/01$/);
    await gov.saveMinutes(w.db, w.finance, meetingId, { note: 'The chair welcomed members.', items: [{ id: itemId, discussion: 'Members agreed the present uniform is too heavy.' }] });
    // Until the minutes are confirmed, the decision is the committee's alone.
    await expect(gov.decision(w.db, w.teacherA, decisionId)).rejects.toThrow(/members/);
  });

  it('circulates the minutes, takes comments, and only the chair confirms; then they are locked', async () => {
    await expect(gov.confirm(w.db, w.admin, meetingId)).rejects.toThrow(/Circulate/);
    await gov.circulate(w.db, w.finance, meetingId);
    await expect(gov.comment(w.db, w.teacherA, meetingId, 'I disagree')).rejects.toThrow();
    await gov.comment(w.db, w.principalA, meetingId, 'Please add that parents were consulted.');
    await expect(gov.confirm(w.db, w.finance, meetingId)).rejects.toThrow(/chair/);
    const c = await gov.confirm(w.db, w.admin, meetingId);
    expect(c.decisions).toBe(1);
    await expect(gov.saveMinutes(w.db, w.finance, meetingId, { note: 'changed' })).rejects.toThrow(/confirmed/);
    await expect(w.db.query(`update meeting set minutes_note = 'tampered' where id = $1`, [meetingId])).rejects.toThrow(/confirmed/);
    const pdf = await gov.minutesPdf(w.db, w.principalA, meetingId);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sends the decision to the school as a circular and tells its principal and the owners', async () => {
    const d = await gov.decision(w.db, w.principalA, decisionId);
    expect(d.status).toBe('DECIDED');
    const n = await w.db.one<{ n: number }>(`select count(*)::int as n from notice where unit_id = $1 and kind = 'CIRCULAR' and title like '%Summer uniform%'`, [w.schoolA]);
    expect(n.n).toBe(1);
    const told = await w.db.query(`select 1 from notification where user_id = $1 and link = $2`, [w.teacherA.id, `/governance/decisions/${decisionId}`]);
    expect(told.length).toBe(1);
    // The action's owner sees it; a teacher elsewhere does not.
    expect((await gov.decision(w.db, w.teacherA, decisionId)).rights.owner).toBe(false);
    await expect(gov.decision(w.db, teacherB, decisionId)).rejects.toThrow();
    await expect(gov.decision(w.db, principalB, decisionId)).rejects.toThrow();
  });

  it('moves with the actions: in progress, then implemented; closed only once the school has reported', async () => {
    const action = (await gov.decision(w.db, w.teacherA, decisionId)).actions[0] as any;
    await expect(gov.updateAction(w.db, teacherB, action.id, { percent: 10, note: 'x' })).rejects.toThrow();
    let d = await gov.updateAction(w.db, w.teacherA, action.id, { percent: 40, note: 'Three suppliers asked for samples' });
    expect(d.status).toBe('IN_PROGRESS');
    expect(d.progress).toBe(40);
    d = await gov.updateAction(w.db, w.teacherA, action.id, { percent: 100, note: 'Samples chosen', status: 'DONE' });
    expect(d.status).toBe('IMPLEMENTED');
    await expect(gov.setDecision(w.db, w.finance, decisionId, { status: 'CLOSED' })).rejects.toThrow(/not reported/);
    await expect(gov.reportAction(w.db, principalB, decisionId, w.schoolA, 'We did it all')).rejects.toThrow();
    await gov.reportAction(w.db, w.principalA, decisionId, w.schoolA, 'Samples shown to parents; orders placed for April.');
    d = await gov.setDecision(w.db, w.finance, decisionId, { status: 'CLOSED', note: 'Done' });
    expect(d.status).toBe('CLOSED');
    expect(d.events.map((e: any) => e.to_status)).toEqual(['PROPOSED', 'DECIDED', 'IN_PROGRESS', 'IMPLEMENTED', 'CLOSED']);
  });

  it('without a quorum takes no decision, and carries a matter needing another meeting onto the next agenda', async () => {
    const g = (await gov.scheduleMeeting(w.db, w.finance, ec, { startsAt: soon(), venue: 'Online', videoLink: 'https://meet.example.org/ec' })).id;
    const m = await gov.meeting(w.db, w.finance, g);
    await gov.attendance(w.db, w.finance, g, [{ memberId: (m.attendance as any[]).find((a) => a.name === 'NES Finance').member_id, status: 'PRESENT' }]);
    await expect(gov.recordDecision(w.db, w.finance, g, { title: 'Fees for 2027-28', body: 'Raise tuition by five per cent.' })).rejects.toThrow(/quorum/i);
    await gov.recordDecision(w.db, w.finance, g, { title: 'Fees for 2027-28', body: 'To be taken up with full members.', outcome: 'NEEDS_MEETING' });
    await gov.circulate(w.db, w.finance, g);
    await gov.confirm(w.db, w.admin, g);
    const next = (await gov.scheduleMeeting(w.db, w.finance, ec, { startsAt: new Date(Date.now() + 10 * 864e5).toISOString(), venue: 'NES HQ' })).id;
    const items = (await gov.meeting(w.db, w.finance, next)).items.map((x: any) => x.title);
    expect(items.some((t: string) => /Fees for 2027-28 \(carried forward/.test(t))).toBe(true);
  });

  it('adopts a resolution by circulation when members vote for it', async () => {
    const d = await gov.proposeByCirculation(w.db, w.finance, ec, { title: 'Holiday on 2 November', body: 'All schools close on 2 November.', closesOn: inDays(3), schoolIds: [w.schoolA, w.schoolB] });
    await expect(gov.vote(w.db, w.teacherA, d.id, { vote: 'YES' })).rejects.toThrow(/Members/);
    await gov.vote(w.db, w.admin, d.id, { vote: 'YES' });
    await expect(gov.vote(w.db, w.admin, d.id, { vote: 'NO' })).rejects.toThrow(/already voted/);
    await gov.vote(w.db, w.finance, d.id, { vote: 'YES' });
    const r = await gov.vote(w.db, w.principalA, d.id, { vote: 'NO' });    // the last member with a sign-in: declared at once
    expect(r.status).toBe('DECIDED');
    expect(r.votes.length).toBe(3);
  });

  it('keeps a confidential committee to its members, even from NES', async () => {
    const cpc = (await gov.createCommittee(w.db, w.principalA, { unitId: w.schoolA, kind: 'CHILD_PROTECTION', quorum: 2,
      members: [{ userId: w.principalA.id, role: 'CHAIR' }, { userId: w.teacherA.id, role: 'CONVENER' }] })).id;
    const seen = await gov.committee(w.db, w.admin, cpc);
    expect(seen.rights.see).toBe(false);
    expect(seen.meetings).toEqual([]);
    const g = (await gov.scheduleMeeting(w.db, w.teacherA, cpc, { startsAt: soon(), venue: 'Principal’s office' })).id;
    await expect(gov.meeting(w.db, w.admin, g)).rejects.toThrow(/members/);
    await expect(gov.meeting(w.db, command, g)).rejects.toThrow(/members/);
    expect((await gov.meeting(w.db, w.principalA, g)).rights.member).toBe(true);
  });

  it('opens the NES Conference to every principal for their school’s topics', async () => {
    const conf = (await gov.createCommittee(w.db, w.admin, { unitId: await nesUnit(), kind: 'CONFERENCE', quorum: 2,
      members: [{ userId: w.admin.id, role: 'CHAIR' }, { userId: w.finance.id, role: 'CONVENER' }] })).id;
    expect((await gov.committees(w.db, principalB)).some((x: any) => x.id === conf)).toBe(true);
    const t = await gov.submitItem(w.db, principalB, conf, { title: 'Science labs for Kindergartens' });
    const c = await gov.committee(w.db, w.finance, conf);
    expect((c.agenda as any[]).find((a) => a.id === t.id).for_school).toBe('NCS Bravo');
    await expect(gov.submitItem(w.db, teacherB, conf, { title: 'A teacher topic' })).rejects.toThrow();
  });

  it('shows the dashboard and each person’s waiting work', async () => {
    const dash = await gov.dashboard(w.db, w.admin);
    expect(dash.totals.closed).toBeGreaterThanOrEqual(1);
    const mine = await gov.mine(w.db, w.principalA);
    expect(mine.forSchool.some((x: any) => /Holiday/.test(x.title))).toBe(true);   // action-taken report due
    const found = await gov.search(w.db, w.principalA, 'uniform');
    expect(found.decisions.length + found.items.length).toBeGreaterThan(0);
    expect(await gov.involved(w.db, w.teacherA)).toBe(true);
    expect(await gov.involved(w.db, teacherB)).toBe(false);
  });
});

describe('inspections', () => {
  let tpl = '', id = '';
  it('NES keeps the checklist; a Command plans a surprise visit the school cannot see until it starts', async () => {
    tpl = (await insp.saveTemplate(w.db, w.admin, { unitId: await nesUnit(), name: 'Annual school inspection', scale: 4,
      sections: [{ title: 'Safety', items: [{ text: 'Fire extinguishers in date', weight: 2 }, { text: 'Drills recorded' }] }, { title: 'Academics', items: [{ text: 'Lesson plans kept' }] }] })).id;
    await expect(insp.saveTemplate(w.db, w.principalA, { unitId: w.schoolA, name: 'Mine', scale: 4, sections: [{ title: 'x', items: [{ text: 'y' }] }] })).rejects.toThrow(/NES and the Commands/);
    await expect(insp.plan(w.db, command, { schoolId: w.schoolB, templateId: tpl, kind: 'ANNUAL', scheduledOn: inDays(2) })).rejects.toThrow(/outside|access/i);
    id = (await insp.plan(w.db, command, { schoolId: w.schoolA, templateId: tpl, kind: 'SURPRISE', scheduledOn: inDays(0) })).id;
    expect((await insp.list(w.db, w.principalA)).some((x: any) => x.id === id)).toBe(false);
    await expect(insp.inspection(w.db, w.principalA, id)).rejects.toThrow();
    await insp.start(w.db, command, id);
    expect((await insp.inspection(w.db, w.principalA, id)).status).toBe('IN_PROGRESS');
  });

  it('rates every item, records findings, reports a weighted score; the school responds and the inspector closes it', async () => {
    await expect(insp.rate(w.db, w.principalA, id, [{ itemId: '1.1', rating: 4 }])).rejects.toThrow();
    await insp.rate(w.db, command, id, [{ itemId: '1.1', rating: 4 }, { itemId: '1.2', rating: 1, remark: 'No drill this term' }]);
    await expect(insp.report(w.db, command, id, 'A well run school with gaps in drills.')).rejects.toThrow(/not rated/);
    await insp.rate(w.db, command, id, [{ itemId: '2.1', notApplicable: true }]);
    await expect(insp.addFinding(w.db, command, id, { itemId: '1.2', severity: 'MAJOR', body: 'Hold and record a fire drill' })).rejects.toThrow(/date/);
    await insp.addFinding(w.db, command, id, { itemId: '1.2', severity: 'MAJOR', body: 'Hold and record a fire drill', dueOn: inDays(30) });
    const r = await insp.report(w.db, command, id, 'A well run school with gaps in drills.');
    expect(r.status).toBe('REPORTED');
    expect(r.score).toBeCloseTo(66.7, 1);   // (1.0 × 2 + 0 × 1) / 3
    const f = r.findings[0] as any;
    await expect(insp.respond(w.db, principalB, f.id, 'Drill held on Monday.')).rejects.toThrow();
    await insp.respond(w.db, w.principalA, f.id, 'Drill held on Monday and recorded in NavShiksha.');
    const done = await insp.decideFinding(w.db, command, f.id, { accept: true });
    expect(done.status).toBe('CLOSED');
    expect((await insp.reportPdfFor(w.db, w.principalA, id)).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('insights', () => {
  it('NES sees the network, a Command its schools, a principal only their school beside the average', async () => {
    const nes: any = await insights.overview(w.db, w.admin);
    expect(nes.level).toBe('network');
    expect(nes.schools.length).toBe(2);
    expect(nes.commands.length).toBe(2);
    const cmd: any = await insights.overview(w.db, command);
    expect(cmd.schools.map((s: any) => s.name)).toEqual(['NCS Alpha']);
    expect(cmd.schools[0].inspection).toBeCloseTo(66.7, 1);
    const own: any = await insights.overview(w.db, w.principalA);
    expect(own.level).toBe('school');
    expect(own.schools.map((s: any) => s.name)).toEqual(['NCS Alpha']);
    expect(own.network.schools).toBe(2);
    await expect(insights.overview(w.db, w.teacherA)).rejects.toThrow(/Insights/);
    await expect(insights.misPack(w.db, w.principalA)).rejects.toThrow(/NES and the Commands/);
    expect((await insights.misPack(w.db, w.admin)).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
