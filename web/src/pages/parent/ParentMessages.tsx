import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, time, words } from '../../api';
import { Empty, useAction, useLoad } from '../../ui';

export default function ParentMessages() {
  const inbox = useLoad<any[]>('/messages');
  const { id } = useParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(id ?? null);
  if (open) return <Thread id={open} onBack={() => { setOpen(null); if (id) navigate('/messages'); inbox.reload(); }} />;
  return (
    <div className="app-shell">
      <h2 className="app-title">Messages</h2>
      {!inbox.data ? <Empty>Loading…</Empty> : inbox.data.length ? inbox.data.map((t) => (
        <button key={t.id} className="card" onClick={() => setOpen(t.id)} style={{ border: 0, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {t.reply_mode === 'REQUIRED' && <span className={`pill ${t.replied ? 'green' : 'orange'}`} style={{ alignSelf: 'flex-start' }}>{t.replied ? 'Replied' : 'Reply needed'}</span>}
          <strong>{t.subject}</strong>
          <span className="small muted">{t.preview}</span>
          <span className="tiny muted">{t.from_name} · {t.from_designation} · {time(t.created_at)}</span>
        </button>
      )) : <Empty>No messages yet.</Empty>}
    </div>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: t, reload } = useLoad<any>(`/messages/${id}`);
  const inbox = useLoad<any[]>('/messages');
  const kids: { studentId: string; name: string }[] = inbox.data?.find((x) => x.id === id)?.children ?? [];
  const [child, setChild] = useState<string>('');
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const studentId = child || kids[0]?.studentId;
  const send = async (choice?: string) => {
    if (await run(() => api(`/messages/${id}/reply`, { body: { choice, body: note, studentId } }), 'Reply sent')) { setNote(''); reload(); }
  };
  if (!t) return <div className="app-shell"><Empty>Loading…</Empty></div>;
  return (
    <div className="app-shell">
      <button className="linkbtn" onClick={onBack} style={{ alignSelf: 'flex-start' }}>‹ Messages</button>
      <h2 style={{ fontSize: '1.7rem' }}>{t.subject}</h2>
      {t.messages.map((m: any) => (
        <article key={m.id} className="card stack" style={{ background: m.mine ? 'var(--blue-soft)' : '#fff', marginLeft: m.mine ? 40 : 0 }}>
          <span className="tiny muted">{m.mine ? `You, about ${m.student_name}` : `${m.sender} · ${m.designation ?? words(m.sender_role)}`} · {time(m.created_at)}</span>
          {m.choice && <span className="pill green" style={{ alignSelf: 'flex-start' }}>{m.choice}</span>}
          {m.body && <p>{m.body}</p>}
        </article>
      ))}
      {t.reply_mode !== 'NONE' && (
        <section className="card stack">
          {kids.length > 1 && (
            <label className="field"><span>This reply is about</span>
              <select className="input" value={studentId} onChange={(e) => setChild(e.target.value)}>{kids.map((k) => <option key={k.studentId} value={k.studentId}>{k.name}</option>)}</select></label>
          )}
          <textarea className="input" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          {t.options?.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${t.options.length}, 1fr)`, gap: 8 }}>
              {t.options.map((o: string) => <button key={o} className="btn big" disabled={busy} onClick={() => send(o)}>{o}</button>)}
            </div>
          ) : <button className="btn big" disabled={busy || !note.trim()} onClick={() => send()}>Send</button>}
        </section>
      )}
    </div>
  );
}
