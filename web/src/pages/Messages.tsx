import { useState } from 'react';
import { api, num, time, words, type User } from '../api';
import { Drawer, Empty, initials, useAction, useLoad } from '../ui';

export default function Messages({ user }: { user: User }) {
  const inbox = useLoad<any[]>('/messages');
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  return (
    <>
      <div className="localnav"><div className="localnav-in"><span className="localnav-title">Messages</span><span className="spacer" /><button className="btn small" onClick={() => setCompose(true)}>New message</button></div></div>
      <main className="page">
        <section className="tile">
          <h2>Conversations</h2>
          {!inbox.data ? <Empty>Loading…</Empty> : inbox.data.length ? inbox.data.map((t) => (
            <button key={t.id} className="list-row" onClick={() => setOpen(t.id)} style={{ width: '100%', border: 0, borderTop: '1px solid var(--line-soft)', background: 'none', textAlign: 'left', cursor: 'pointer', gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <div><div style={{ fontWeight: 600 }}>{t.subject}</div><div className="small muted">Class {t.class_code}-{t.section} · {num(t.recipients)} families · {time(t.last_at)}</div></div>
              <span style={{ display: 'flex', gap: 6 }}>
                {t.reply_mode === 'REQUIRED' && <span className="pill blue">{t.replied} of {t.recipients} replied</span>}
                {t.unread > 0 && <span className="pill orange">{t.unread} new</span>}
              </span>
            </button>
          )) : <Empty>No conversations yet.</Empty>}
        </section>
      </main>
      {open && <ThreadDrawer id={open} user={user} onClose={() => { setOpen(null); inbox.reload(); }} />}
      {compose && <Compose onClose={() => { setCompose(false); inbox.reload(); }} />}
    </>
  );
}

function ThreadDrawer({ id, user, onClose }: { id: string; user: User; onClose: () => void }) {
  const { data: t, reload } = useLoad<any>(`/messages/${id}`);
  const responses = useLoad<any[]>(`/messages/${id}/responses`);
  const { run, busy } = useAction();
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'chat' | 'tracker'>('chat');
  if (!t) return <Drawer title="Conversation" onClose={onClose}><Empty>Loading…</Empty></Drawer>;
  const pending = (responses.data ?? []).filter((r) => !r.choice && !r.note);
  return (
    <Drawer title={t.subject} onClose={onClose}>
      {t.reply_mode === 'REQUIRED' && <div className="seg"><button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Replies</button><button className={tab === 'tracker' ? 'on' : ''} onClick={() => setTab('tracker')}>Who has answered</button></div>}
      {tab === 'chat' ? (
        <section className="stack">
          {t.messages.map((m: any) => (
            <article key={m.id} className="card stack" style={{ marginLeft: m.mine ? 40 : 0, background: m.mine ? 'var(--blue-soft)' : '#fff' }}>
              {m.student_name ? (
                <div className="identity">
                  <span className="avatar" style={{ background: 'var(--blue)' }}>{initials(m.student_name)}</span>
                  <div><div className="who-line">{m.student_name} · {m.class_code}{m.section ? `-${m.section}` : ''} · <span className="mono">{m.admission_no}</span></div>
                    <div className="meta">{m.sender} ({words(m.relationship)}) · {time(m.created_at)}</div></div>
                </div>
              ) : <div className="meta small muted">{m.sender} · {m.designation ?? words(m.sender_role)} · {time(m.created_at)}</div>}
              {m.choice && <span className="pill green" style={{ alignSelf: 'flex-start' }}>Answered: {m.choice}</span>}
              {m.body && <p>{m.body}</p>}
            </article>
          ))}
          <div className="card stack">
            <textarea className="input" placeholder="Write to all families in this conversation" value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply" />
            <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={busy || !text.trim()} onClick={async () => { if (await run(() => api(`/messages/${id}/reply`, { body: { body: text } }), 'Sent')) { setText(''); reload(); } }}>Send</button>
          </div>
        </section>
      ) : (
        <section className="tile tight">
          <div className="kpis" style={{ marginBottom: 12 }}>
            {(t.options as string[]).map((o) => <div key={o}><div className="kpi-label">{o}</div><div className="kpi-value">{(responses.data ?? []).filter((r) => r.choice === o).length}</div></div>)}
            <div><div className="kpi-label">Not answered</div><div className="kpi-value" style={{ color: 'var(--orange)' }}>{pending.length}</div></div>
          </div>
          <table className="table"><thead><tr><th>Student</th><th>Adm. no.</th><th>Parent</th><th>Answer</th></tr></thead>
            <tbody>{(responses.data ?? []).map((r) => (
              <tr key={r.student_id}><td style={{ fontWeight: 600 }}>{r.student_name}<div className="tiny muted">{r.class_code}-{r.section}</div></td><td className="mono small">{r.admission_no}</td>
                <td className="small">{r.guardian_name}<div className="tiny muted">{words(r.relationship)}</div></td>
                <td>{r.choice ? <span className={`pill ${r.choice === 'Yes' ? 'green' : 'red'}`}>{r.choice}</span> : <span className="pill orange">Waiting</span>}{r.note && <div className="tiny muted">{r.note}</div>}</td></tr>))}</tbody>
          </table>
        </section>
      )}
      <p className="tiny muted">{user.name} sees replies from every family; families see only their own replies and staff messages.</p>
    </Drawer>
  );
}

function Compose({ onClose }: { onClose: () => void }) {
  const { data: sections } = useLoad<any[]>('/sections');
  const { run, busy } = useAction();
  const [f, setF] = useState({ sectionId: '', subject: '', body: '', replyMode: 'REQUIRED', options: 'Yes, No' });
  return (
    <Drawer title="New message" onClose={onClose}>
      <section className="tile tight stack">
        <label className="field"><span>To the families of</span><select className="input" value={f.sectionId} onChange={(e) => setF({ ...f, sectionId: e.target.value })}>
          <option value="">Choose a class</option>{(sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.class_name}-{s.name} · {s.campus} ({s.strength})</option>)}</select></label>
        <label className="field"><span>Subject</span><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="field"><span>Message</span><textarea className="input" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <div className="seg">{['NONE', 'ALLOWED', 'REQUIRED'].map((m) => <button key={m} className={f.replyMode === m ? 'on' : ''} onClick={() => setF({ ...f, replyMode: m })}>{m === 'NONE' ? 'No replies' : m === 'ALLOWED' ? 'Replies allowed' : 'Reply needed'}</button>)}</div>
        {f.replyMode === 'REQUIRED' && <label className="field"><span>Answer choices, separated by commas</span><input className="input" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></label>}
        <button className="btn big" disabled={busy || !f.sectionId || !f.subject || !f.body} onClick={async () => {
          const options = f.replyMode === 'REQUIRED' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : [];
          if (await run(() => api('/messages', { body: { sectionId: f.sectionId, subject: f.subject, body: f.body, replyMode: f.replyMode, options } }), 'Message sent')) onClose();
        }}>Send</button>
      </section>
    </Drawer>
  );
}
