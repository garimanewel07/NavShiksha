import { useEffect, useState } from 'react';
import { api, day, today } from '../api';
import { Empty, useAction, useLoad, useToast } from '../ui';

export default function Attendance() {
  const { data: all } = useLoad<any[]>('/my/sections');
  const sections = all?.filter((s) => s.can_take_roll);
  const [sectionId, setSectionId] = useState(() => new URLSearchParams(location.search).get('section') ?? '');
  const [date, setDate] = useState(today());
  useEffect(() => { if (!sectionId && sections?.length) setSectionId(sections.find((s) => s.is_class_teacher)?.id ?? sections[0].id); }, [sections, sectionId]);
  const roster = useLoad<any>(sectionId ? `/sections/${sectionId}/attendance?date=${date}` : null, [sectionId, date]);
  const [marks, setMarks] = useState<Record<string, 'P' | 'A' | 'L'>>({});
  useEffect(() => { setMarks(Object.fromEntries((roster.data?.students ?? []).map((s: any) => [s.enrolment_id, s.status ?? 'P']))); }, [roster.data]);
  const { run, busy } = useAction();
  const toast = useToast();
  const locked = roster.data?.correctionPending;
  const counts = { P: 0, A: 0, L: 0 } as Record<string, number>;
  Object.values(marks).forEach((m) => counts[m]++);
  const cycle = (id: string) => !locked && setMarks((x) => ({ ...x, [id]: x[id] === 'P' ? 'A' : x[id] === 'A' ? 'L' : 'P' }));
  if (sections && !sections.length) return <main className="page"><Empty>The daily roll is taken by class teachers, the attendance officer and the principal. You have no class to take it for.</Empty></main>;
  return (
    <>
      <div className="localnav"><div className="localnav-in">
        <span className="localnav-title">Attendance</span><span className="spacer" />
        <select className="input" style={{ height: 36, width: 'auto' }} value={sectionId} onChange={(e) => setSectionId(e.target.value)} aria-label="Class">
          {(sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.class_code}-{s.name} · {s.campus}{s.is_class_teacher ? ' (my class)' : s.is_co_class_teacher ? ' (co-class teacher)' : ''}</option>)}</select>
        <input className="input" type="date" style={{ height: 36, width: 'auto' }} max={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      </div></div>
      <main className="page">
        <section className="tile">
          <div className="tile-head">
            <div><h2>{day(date)}</h2><p className="muted" style={{ marginTop: 6 }}>{roster.data?.correctionPending ? 'A correction for this day is waiting for approval.' : roster.data?.needsApproval ? `This day is more than ${roster.data.windowDays} days old. Changes go to the principal for approval before they apply.` : roster.data?.markedAt ? `Taken. You can correct it for ${roster.data?.windowDays} days.` : 'Everyone starts present. Tap a name to mark absent, then leave.'}</p></div>
            <div style={{ display: 'flex', gap: 8 }}><span className="pill green">{counts.P} present</span><span className="pill red">{counts.A} absent</span><span className="pill orange">{counts.L} leave</span></div>
          </div>
          {sections && !sections.length ? <Empty>You have no roll to take today. The roll is taken by each class's class teacher, or by the co-class teacher while they are away.</Empty> : !roster.data ? <Empty>Loading…</Empty> : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              {roster.data.students.map((s: any) => {
                const m = marks[s.enrolment_id] ?? 'P';
                const bg = m === 'P' ? '#fff' : m === 'A' ? 'var(--red-soft)' : 'var(--orange-soft)';
                return (
                  <button key={s.enrolment_id} onClick={() => cycle(s.enrolment_id)} disabled={locked} aria-pressed={m !== 'P'}
                    style={{ border: '1px solid var(--line-soft)', background: bg, borderRadius: 16, padding: '12px 14px', textAlign: 'left', cursor: locked ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 10, minHeight: 60 }}>
                    <span style={{ flex: 1, lineHeight: 1.25 }}><span style={{ display: 'block', fontWeight: 600 }}>{s.name}</span><span className="tiny muted mono">{s.admission_no}</span></span>
                    <span style={{ fontWeight: 700, color: m === 'P' ? 'var(--green)' : m === 'A' ? 'var(--red)' : 'var(--orange)' }}>{m === 'P' ? 'Present' : m === 'A' ? 'Absent' : 'Leave'}</span>
                  </button>
                );
              })}
            </div>
          )}
          {!locked && roster.data && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn big" disabled={busy} onClick={async () => {
                const absent = Object.entries(marks).filter(([, v]) => v !== 'P').map(([enrolmentId, status]) => ({ enrolmentId, status }));
                const r = await run(() => api<any>(`/sections/${sectionId}/attendance`, { method: 'PUT', body: { date, absent } }));
                if (r) { toast(r.pendingApproval ? `Sent to the ${String(r.approver).toLowerCase()} for approval.` : `Saved. Parents of ${counts.A} absent children are notified.`); roster.reload(); }
              }}>{roster.data.needsApproval ? 'Send correction for approval' : 'Save attendance'}</button>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
