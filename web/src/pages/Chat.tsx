import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, session, type User } from '../api';
import { Drawer, Empty, initials, useAction, useLoad, useToast, ask, tell } from '../ui';
import * as cc from '../lib/chatCrypto';
import { forgetDeviceKey, loadDeviceKey, saveDeviceKey } from '../lib/chatStore';
import { FailedPage } from '../errors';

/**
 * Staff chat: one-to-one, groups, every school's staff group, the principals of all Navy
 * schools, and NES and Command announcement channels. Everything is end-to-end encrypted on this
 * device before it is sent (see lib/chatCrypto); the server keeps only what it cannot read.
 */

interface Identity extends cc.IdentityBody { keyVersion: number }
interface Conv { id: string; kind: 'DIRECT' | 'GROUP' | 'CHANNEL'; auto: string | null; title: string; subtitle: string | null; members: number; unread: number; can_post: boolean; role: string;
  last_message_at: string | null; last_id: string | null; last_kind: string | null; last_epoch: number | null; last_iv: string | null; last_ciphertext: string | null;
  last_system: string | null; last_deleted: boolean; last_sender: string | null; last_sender_id: string | null; needs_keys: boolean }
interface Member { id: string; name: string; designation: string | null; unit: string; role: string; can_post: boolean; public_key: string | null; key_version: number | null; fingerprint: string | null }
interface Detail { id: string; kind: string; auto: string | null; title: string; myRole: string; canPost: boolean; epoch: number; needsEpoch: number; members: Member[];
  myKeys: { epoch: number; wrappedKey: string; iv: string; wrappedBy: string; wrapperPublicKey: string }[]; missing: string[] }
interface Msg { id: string; senderId: string | null; sender: string | null; kind: 'TEXT' | 'FILE' | 'SYSTEM'; epoch: number | null; iv: string | null; ciphertext: string | null;
  systemText: string | null; attachmentId: string | null; size: number | null; replyTo: string | null; createdAt: string; deleted: boolean }
type Opened = cc.Payload | { t: 'nokey' } | { t: 'broken' };

const MAX_FILE = 25 * 1024 * 1024;
const OK_FILE = /\.(jpe?g|png|webp|gif|pdf|docx?|xlsx?|pptx?|txt|csv|odt|ods)$/i;
const IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const clock = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayLabel = (d: string) => {
  const x = new Date(d), t = new Date(), y = new Date(Date.now() - 864e5);
  if (x.toDateString() === t.toDateString()) return 'Today';
  if (x.toDateString() === y.toDateString()) return 'Yesterday';
  return x.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: x.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
};
/** "Mrs Lata Menon" → "Lata"; ranks and titles are left out. */
const firstName = (n: string) => n.replace(/^((Lt Cdr|Cdr|Capt|Cmde|Lt|Sub Lt|Mrs|Mr|Ms|Dr|PO|CPO)\.?\s+)+/, '').split(' ')[0];
const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function raw(path: string, init: RequestInit = {}) {
  const s = session();
  const res = await fetch(`/api/v1${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(s ? { authorization: `Bearer ${s.token}` } : {}) } });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d?.error?.code ?? 'error', d?.error?.message ?? 'Something went wrong.'); }
  return res;
}

export default function Chat({ user }: { user: User }) {
  const idq = useLoad<{ identity: Identity | null }>('/chat/identity');
  const [device, setDevice] = useState<CryptoKey | null | undefined>(undefined);
  const identity = idq.data?.identity ?? null;
  useEffect(() => {
    if (!idq.data) return;
    loadDeviceKey(user.id).then((k) => setDevice(k && identity && k.keyVersion === identity.keyVersion ? k.privateKey : null));
  }, [idq.data, user.id, identity]);
  if (idq.error) return <FailedPage error={idq.error} />;
  if (!idq.data || device === undefined) return <main className="page"><Empty>Opening secure chat…</Empty></main>;
  if (!identity) return <SetUp user={user} onDone={(k) => { setDevice(k); idq.reload(); }} />;
  if (!device) return <Unlock user={user} identity={identity} onDone={setDevice} onReset={() => idq.reload()} />;
  return <ChatApp user={user} device={device} identity={identity} onLock={async () => { await forgetDeviceKey(user.id); setDevice(null); }} />;
}

// ── Setting up and unlocking ─────────────────────────────────────────────────────────────────

function PinFields({ pin, setPin, again, setAgain }: { pin: string; setPin: (s: string) => void; again?: string; setAgain?: (s: string) => void }) {
  return (
    <div className="form-grid">
      <label className="field"><span>Chat PIN</span><input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={12} autoFocus /></label>
      {setAgain && <label className="field"><span>The same PIN again</span><input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))} maxLength={12} /></label>}
    </div>
  );
}

function SetUp({ user, onDone }: { user: User; onDone: (k: CryptoKey) => void }) {
  const [pin, setPin] = useState(''), [again, setAgain] = useState('');
  const { run, busy } = useAction();
  const problem = cc.pinProblem(pin) ?? (again && pin !== again ? 'The two PINs differ.' : null);
  return (
    <main className="page" style={{ maxWidth: 640 }}>
      <section className="tile stack">
        <div className="eyebrow">Secure chat</div>
        <h2>Set up your chat PIN</h2>
        <p className="muted">Chats with colleagues, groups and announcements from NES are encrypted on your device before they are sent. Nobody else can read them: not the school, not NES, not the people who run the servers.</p>
        <p className="muted">Your PIN protects your chat key. You will need it once on every new phone or computer. <strong>If you forget it, your earlier messages cannot be recovered</strong>; you can start again with a new PIN.</p>
        <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} />
        {pin.length >= 4 && problem && <span className="small" style={{ color: 'var(--red)' }}>{problem}</span>}
        <button className="btn big" disabled={busy || !!problem || pin !== again} onClick={async () => {
          const ok = await run(async () => {
            const { body, privateKey } = await cc.createIdentity(pin);
            const r = await api<{ keyVersion: number }>('/chat/identity', { body });
            await saveDeviceKey(user.id, { keyVersion: r.keyVersion, privateKey });
            return privateKey;
          }, 'Secure chat is ready');
          if (ok) onDone(ok);
        }}>{busy ? 'Making your key…' : 'Set up secure chat'}</button>
      </section>
    </main>
  );
}

function Unlock({ user, identity, onDone, onReset }: { user: User; identity: Identity; onDone: (k: CryptoKey) => void; onReset: () => void }) {
  const [pin, setPin] = useState(''), [again, setAgain] = useState('');
  const [forgot, setForgot] = useState(false);
  const { run, busy } = useAction();
  const problem = cc.pinProblem(pin) ?? (again && pin !== again ? 'The two PINs differ.' : null);
  return (
    <main className="page" style={{ maxWidth: 640 }}>
      {!forgot ? <section className="tile stack">
        <div className="eyebrow">Secure chat</div>
        <h2>Enter your chat PIN</h2>
        <p className="muted">This device has not opened your chats before (or you locked it). Your PIN opens your chat key here; it is not sent anywhere.</p>
        <PinFields pin={pin} setPin={setPin} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn big" disabled={busy || pin.length < 6} onClick={async () => {
            const k = await run(async () => { const key = await cc.unlockIdentity(identity, pin); await saveDeviceKey(user.id, { keyVersion: identity.keyVersion, privateKey: key }); return key; });
            if (k) onDone(k);
          }}>{busy ? 'Checking…' : 'Open chats'}</button>
          <button className="linkbtn small" onClick={() => { setForgot(true); setPin(''); }}>Forgot the PIN?</button>
        </div>
        <span className="tiny muted">Your security code: <span className="mono">{identity.fingerprint}</span></span>
      </section> : <section className="tile stack">
        <h2>Start again with a new PIN</h2>
        <div className="callout orange">A new PIN means a new chat key. Messages sent to you before now <strong>cannot be read again</strong> on any device. Your colleagues will see that your security code changed, and new messages will reach you as usual.</div>
        <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} />
        {pin.length >= 4 && problem && <span className="small" style={{ color: 'var(--red)' }}>{problem}</span>}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn danger" disabled={busy || !!problem || pin !== again} onClick={async () => {
            const ok = await run(async () => {
              const { body, privateKey } = await cc.createIdentity(pin);
              const r = await api<{ keyVersion: number }>('/chat/identity/reset', { body });
              await saveDeviceKey(user.id, { keyVersion: r.keyVersion, privateKey });
              return true;
            }, 'New chat key made');
            if (ok) onReset();
          }}>Make a new key</button>
          <button className="btn quiet" onClick={() => setForgot(false)}>I remember it</button>
        </div>
      </section>}
    </main>
  );
}

// ── The chat app ───────────────────────────────────────────────────────────────────────────

/** Keys and work shared by the list and the open conversation. */
function useKeyring(user: User, device: CryptoKey) {
  const ring = useRef(new Map<string, Uint8Array>());
  /** What this device does on opening a conversation: start a new key if members changed, share the key with anyone missing it, open its own keys. */
  const prepare = useCallback(async (id: string): Promise<Detail> => {
    let d = await api<Detail>(`/chat/conversations/${id}`);
    const ready = d.members.filter((m) => m.public_key && m.key_version);
    if (d.needsEpoch > d.epoch) {
      const k = cc.newConversationKey();
      const envelopes = await Promise.all(ready.map(async (m) => ({ userId: m.id, recipientKeyVersion: m.key_version!, ...(await cc.wrapKey(k, device, m.public_key!, cc.keyInfo(id, d.needsEpoch, m.id))) })));
      try { await api(`/chat/conversations/${id}/keys`, { body: { epoch: d.needsEpoch, envelopes } }); } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; }
      d = await api<Detail>(`/chat/conversations/${id}`);
    }
    for (const k of d.myKeys) {
      const slot = `${id}:${k.epoch}`;
      if (ring.current.has(slot)) continue;
      try { ring.current.set(slot, await cc.unwrapKey(k.wrappedKey, k.iv, device, k.wrapperPublicKey, cc.keyInfo(id, k.epoch, user.id))); } catch { /* wrapped for an older key of mine */ }
    }
    const mine = ring.current.get(`${id}:${d.epoch}`);
    const missing = ready.filter((m) => d.missing.includes(m.id));
    if (mine && missing.length) {
      const envelopes = await Promise.all(missing.map(async (m) => ({ userId: m.id, recipientKeyVersion: m.key_version!, ...(await cc.wrapKey(mine, device, m.public_key!, cc.keyInfo(id, d.epoch, m.id))) })));
      await api(`/chat/conversations/${id}/keys`, { body: { epoch: d.epoch, envelopes } }).catch(() => {});
    }
    return d;
  }, [device, user.id]);
  const openMsg = useCallback(async (convId: string, m: { epoch: number | null; iv: string | null; ciphertext: string | null; senderId: string | null }): Promise<Opened> => {
    const k = m.epoch ? ring.current.get(`${convId}:${m.epoch}`) : undefined;
    if (!k || !m.iv || !m.ciphertext || !m.senderId) return { t: 'nokey' };
    try { return await cc.open(k, m.iv, m.ciphertext, cc.messageAad(convId, m.epoch!, m.senderId)); } catch { return { t: 'broken' }; }
  }, []);
  return { ring, prepare, openMsg };
}

function ChatApp({ user, device, identity, onLock }: { user: User; device: CryptoKey; identity: Identity; onLock: () => void }) {
  const { id } = useParams();
  const nav = useNavigate();
  const keys = useKeyring(user, device);
  const [list, setList] = useState<Conv[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [drawer, setDrawer] = useState<'' | 'direct' | 'group'>('');
  const load = useCallback(async () => {
    const l = await api<Conv[]>('/chat/conversations').catch(() => null);
    if (!l) return;
    setList(l);
    // Keys: share them with colleagues who set up chat since, or start a new one after members changed.
    for (const c of l.filter((x) => x.needs_keys)) await keys.prepare(c.id).catch(() => null);
    // Previews of the last message; conversations not opened yet on this device get their keys first.
    for (const c of l.filter((x) => x.last_epoch && !keys.ring.current.has(`${x.id}:${x.last_epoch}`)).slice(0, 10)) await keys.prepare(c.id).catch(() => null);
    const p: Record<string, string> = {};
    for (const c of l) {
      if (c.last_system) p[c.id] = c.last_system;
      else if (c.last_deleted) p[c.id] = 'Message deleted';
      else if (c.last_ciphertext) {
        const o = await keys.openMsg(c.id, { epoch: c.last_epoch, iv: c.last_iv, ciphertext: c.last_ciphertext, senderId: c.last_sender_id });
        const who = c.kind !== 'DIRECT' && c.last_sender ? `${c.last_sender_id === user.id ? 'You' : firstName(c.last_sender)}: ` : '';
        p[c.id] = who + (o.t === 'text' ? o.body : o.t === 'file' ? (IMAGE.test(o.mime) ? 'Photo' : o.name) : 'Encrypted message');
      }
    }
    setPreviews(p);
  }, [keys, user.id]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  const shown = (list ?? []).filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const current = list?.find((c) => c.id === id) ?? null;
  return (
    <div className={`chat${id ? ' has-open' : ''}`}>
      <aside className="chat-list">
        <div className="chat-list-head">
          <h3>Chats</h3><span className="spacer" />
          <button className="btn quiet small" onClick={() => setDrawer('direct')}>New chat</button>
          <button className="btn quiet small" onClick={() => setDrawer('group')}>New group</button>
        </div>
        <input className="input" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '0 12px 8px', width: 'calc(100% - 24px)' }} />
        <div className="chat-items">
          {!list ? <Empty>Loading…</Empty> : !shown.length ? <Empty>No chats yet. Start one with New chat.</Empty> : shown.map((c) => (
            <button key={c.id} className={`chat-item${c.id === id ? ' on' : ''}`} onClick={() => nav(`/chat/${c.id}`)}>
              <span className={`avatar chat-av ${c.kind.toLowerCase()}`}>{c.kind === 'CHANNEL' ? '📢' : c.kind === 'GROUP' ? '👥' : initials(c.title)}</span>
              <span className="chat-item-main">
                <span className="chat-item-top"><strong>{c.title}</strong><span className="tiny muted">{c.last_message_at ? (dayLabel(c.last_message_at) === 'Today' ? clock(c.last_message_at) : dayLabel(c.last_message_at)) : ''}</span></span>
                <span className="chat-item-bottom"><span className="small muted ellipsis">{previews[c.id] ?? (c.kind === 'DIRECT' ? c.subtitle ?? '' : `${c.members} ${c.members === 1 ? 'member' : 'members'}`)}</span>
                  {c.unread > 0 && <span className="chat-badge">{c.unread > 99 ? '99+' : c.unread}</span>}</span>
              </span>
            </button>))}
        </div>
        <div className="chat-list-foot tiny muted">🔒 End-to-end encrypted · your code <span className="mono">{identity.fingerprint.slice(0, 11)}</span> · <button className="linkbtn tiny" onClick={onLock}>Lock on this device</button></div>
      </aside>
      <section className="chat-main">
        {id ? <Conversation key={id} id={id} user={user} device={device} keys={keys} conv={current} onBack={() => nav('/chat')} onChanged={load} myFingerprint={identity.fingerprint} />
          : <div className="chat-empty"><img src="/brand/navshiksha/emblem-160.png" alt="" style={{ height: 88 }} /><h3>NavShiksha chat</h3><p className="muted">Talk to colleagues in your school and across the Navy schools, NES and the Commands. Everything is end-to-end encrypted.</p></div>}
      </section>
      {drawer === 'direct' && <PeoplePicker title="New chat" onClose={() => setDrawer('')} onPick={async (ids) => { const r = await api<{ id: string }>('/chat/direct', { body: { userId: ids[0] } }); setDrawer(''); await load(); nav(`/chat/${r.id}`); }} />}
      {drawer === 'group' && <PeoplePicker title="New group" multi onClose={() => setDrawer('')} onPick={async (ids, title) => { const r = await api<{ id: string }>('/chat/groups', { body: { title, memberIds: ids } }); setDrawer(''); await load(); nav(`/chat/${r.id}`); }} />}
    </div>
  );
}

function PeoplePicker({ title, multi, onClose, onPick, exclude = [] }: { title: string; multi?: boolean; onClose: () => void; onPick: (ids: string[], title: string) => Promise<void>; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState('');
  const people = useLoad<{ id: string; name: string; designation: string | null; unit: string; ready: boolean }[]>(q.trim().length >= 2 ? `/chat/people?q=${encodeURIComponent(q.trim())}` : null, [q]);
  const { run, busy } = useAction();
  return (
    <Drawer title={title} onClose={onClose}>
      <section className="tile tight stack">
        {multi && title === 'New group' && <label className="field"><span>Group name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Class X teachers" maxLength={80} /></label>}
        <label className="field"><span>Find staff in any Navy school, NES or a Command</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or designation" autoFocus /></label>
        {multi && picked.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{picked.map((p) => <button key={p.id} className="pill blue" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>{p.name} ✕</button>)}</div>}
        {(people.data ?? []).filter((p) => !exclude.includes(p.id)).map((p) => (
          <button key={p.id} className="list-row" style={{ gridTemplateColumns: 'auto 1fr auto', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
            onClick={async () => { if (!multi) { await run(() => onPick([p.id], '')); return; } if (!picked.some((x) => x.id === p.id)) setPicked([...picked, { id: p.id, name: p.name }]); }}>
            <span className="avatar" style={{ width: 36, height: 36, fontSize: '0.75rem' }}>{initials(p.name)}</span>
            <span><strong>{p.name}</strong><span className="tiny muted" style={{ display: 'block' }}>{p.designation ?? ''}{p.designation ? ' · ' : ''}{p.unit}</span></span>
            {!p.ready && <span className="tiny muted">not set up yet</span>}
          </button>))}
        {multi && <button className="btn" disabled={busy || !picked.length || (title === 'New group' && name.trim().length < 2)} onClick={() => run(() => onPick(picked.map((p) => p.id), name.trim()))}>{title === 'New group' ? `Make group (${picked.length + 1})` : `Add ${picked.length}`}</button>}
        <p className="tiny muted">People who have not set up chat yet receive the conversation key when they do.</p>
      </section>
    </Drawer>
  );
}

function Conversation({ id, user, device, keys, conv, onBack, onChanged, myFingerprint }: { id: string; user: User; device: CryptoKey; keys: ReturnType<typeof useKeyring>; conv: Conv | null;
  onBack: () => void; onChanged: () => void; myFingerprint: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(false);
  const [more, setMore] = useState(true);
  const [sending, setSending] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  void device;

  const decrypt = useCallback(async (list: Msg[]) => {
    const out: Record<string, Opened> = {};
    for (const m of list) if (m.kind !== 'SYSTEM' && !m.deleted) out[m.id] = await keys.openMsg(id, m);
    setOpened((o) => ({ ...o, ...out }));
  }, [id, keys]);

  const refresh = useCallback(async () => {
    const d = await keys.prepare(id);
    setDetail(d);
    return d;
  }, [id, keys]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await refresh();
        const m = await api<Msg[]>(`/chat/conversations/${id}/messages?limit=60`);
        if (!live) return;
        setMsgs(m); setMore(m.length === 60); await decrypt(m);
        await api(`/chat/conversations/${id}/read`, { method: 'POST' }); onChanged();
        setTimeout(() => bottom.current?.scrollIntoView(), 30);
      } catch (e) { setError((e as Error).message); }
    })();
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // New messages every few seconds; the key state is refreshed when someone joins or leaves.
  const last = msgs.at(-1)?.createdAt;
  useEffect(() => {
    const t = setInterval(async () => {
      const fresh = await api<Msg[]>(`/chat/conversations/${id}/messages?after=${encodeURIComponent(last ?? new Date(0).toISOString())}`).catch(() => null);
      if (!fresh?.length) return;
      if (fresh.some((m) => m.epoch && !keys.ring.current.has(`${id}:${m.epoch}`)) || fresh.some((m) => m.kind === 'SYSTEM')) await refresh().catch(() => null);
      setMsgs((x) => [...x, ...fresh.filter((f) => !x.some((y) => y.id === f.id))]);
      await decrypt(fresh);
      await api(`/chat/conversations/${id}/read`, { method: 'POST' }).catch(() => null);
      onChanged();
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 30);
    }, 3000);
    return () => clearInterval(t);
  }, [id, last, keys, decrypt, refresh, onChanged]);

  /** Seals and sends; if the key changed meanwhile (someone joined or left), prepares the new key and tries once more. */
  const post = async (payload: cc.Payload, attachmentId?: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = attempt === 0 && detail && detail.epoch === detail.needsEpoch ? detail : await refresh();
      const k = keys.ring.current.get(`${id}:${d.epoch}`);
      if (!k) throw new Error('This device does not have the conversation key yet. It arrives when another member opens the chat.');
      const sealed = await cc.seal(k, payload, cc.messageAad(id, d.epoch, user.id));
      try {
        const r = await api<{ id: string; created_at: string }>(`/chat/conversations/${id}/messages`, { body: { epoch: d.epoch, ...sealed, attachmentId: attachmentId ?? null } });
        const mine: Msg = { id: r.id, senderId: user.id, sender: user.name, kind: attachmentId ? 'FILE' : 'TEXT', epoch: d.epoch, ...sealed, systemText: null, attachmentId: attachmentId ?? null,
          size: payload.t === 'file' ? payload.size : null, replyTo: null, createdAt: r.created_at, deleted: false };
        setMsgs((x) => [...x, mine]); setOpened((o) => ({ ...o, [r.id]: payload }));
        setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 30);
        onChanged();
        return;
      } catch (e) { if (!(e instanceof ApiError && e.status === 409) || attempt === 1) throw e; }
    }
  };

  const sendText = async () => {
    const body = text.trim();
    if (!body) return;
    setSending('text');
    try { await post({ t: 'text', body }); setText(''); } catch (e) { toast((e as Error).message); } finally { setSending(''); }
  };

  const sendFile = async (f: File) => {
    if (f.size > MAX_FILE) { toast('Files can be up to 25 MB.'); return; }
    if (!OK_FILE.test(f.name)) { toast('Send photos (JPG, PNG, WEBP, GIF) or documents (PDF, Word, Excel, PowerPoint, text, CSV).'); return; }
    setSending('file');
    try {
      const plain = new Uint8Array(await f.arrayBuffer());
      const sealed = await cc.sealFile(plain);
      const up = await (await raw(`/chat/conversations/${id}/files`, { method: 'POST', body: sealed.data as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream' } })).json() as { id: string };
      await post({ t: 'file', name: f.name, mime: f.type || 'application/octet-stream', size: f.size, key: sealed.key, iv: sealed.iv }, up.id);
    } catch (e) { toast((e as Error).message); } finally { setSending(''); if (fileInput.current) fileInput.current.value = ''; }
  };

  const older = async () => {
    const first = msgs[0]?.createdAt;
    if (!first) return;
    const m = await api<Msg[]>(`/chat/conversations/${id}/messages?before=${encodeURIComponent(first)}&limit=60`);
    setMsgs((x) => [...m, ...x]); setMore(m.length === 60); await decrypt(m);
  };

  const del = async (m: Msg) => {
    if (!await ask('Delete this message for everyone?')) return;
    await api(`/chat/messages/${m.id}`, { method: 'DELETE' }).then(() => setMsgs((x) => x.map((y) => (y.id === m.id ? { ...y, deleted: true } : y)))).catch((e) => toast(e.message));
  };

  const title = detail?.title ?? conv?.title ?? 'Chat';
  const sub = detail ? (detail.kind === 'DIRECT' ? detail.members.find((m) => m.id !== user.id)?.designation ?? '' : `${detail.members.length} ${detail.members.length === 1 ? 'member' : 'members'}${detail.auto ? ' · kept up to date with the staff lists' : ''}`) : '';
  const notReady = detail?.members.filter((m) => !m.public_key && m.id !== user.id) ?? [];
  let lastDay = '';
  return (
    <>
      <div className="chat-head">
        <button className="linkbtn chat-back" onClick={onBack} aria-label="Back to chats">‹</button>
        <span className={`avatar chat-av ${(detail?.kind ?? conv?.kind ?? 'direct').toLowerCase()}`}>{(detail?.kind ?? conv?.kind) === 'CHANNEL' ? '📢' : (detail?.kind ?? conv?.kind) === 'GROUP' ? '👥' : initials(title)}</span>
        <span style={{ flex: 1, minWidth: 0 }}><strong className="ellipsis" style={{ display: 'block' }}>{title}</strong><span className="tiny muted ellipsis" style={{ display: 'block' }}>{sub}</span></span>
        <button className="btn quiet small" onClick={() => setInfo(true)}>Info</button>
      </div>
      <div className="chat-scroll">
        <div className="chat-note tiny">🔒 Messages and files here are end-to-end encrypted. Only the people in this chat can read them.</div>
        {error && <div className="callout red small" style={{ margin: 12 }}>{error}</div>}
        {more && msgs.length > 0 && <div style={{ textAlign: 'center' }}><button className="linkbtn small" onClick={older}>Earlier messages</button></div>}
        {msgs.map((m) => {
          const d = dayLabel(m.createdAt);
          const sep = d !== lastDay ? <div className="chat-day" key={`d${m.id}`}><span>{d}</span></div> : null;
          lastDay = d;
          if (m.kind === 'SYSTEM') return <div key={m.id}>{sep}<div className="chat-system tiny">{m.systemText}</div></div>;
          const mine = m.senderId === user.id;
          const o = opened[m.id];
          return (
            <div key={m.id}>{sep}
              <div className={`bubble-row${mine ? ' mine' : ''}`}>
                <div className={`bubble${mine ? ' mine' : ''}`}>
                  {!mine && detail?.kind !== 'DIRECT' && <div className="bubble-who">{m.sender}</div>}
                  {m.deleted ? <em className="muted">This message was deleted</em>
                    : !o ? <span className="muted">…</span>
                    : o.t === 'text' ? <span className="bubble-text">{o.body}</span>
                    : o.t === 'file' ? <FileBubble id={m.attachmentId!} p={o} />
                    : o.t === 'nokey' ? <em className="muted">Waiting for this message’s key from another member…</em>
                    : <em style={{ color: 'var(--red)' }}>This message could not be opened (it may have been altered).</em>}
                  <div className="bubble-meta">{clock(m.createdAt)}{mine && !m.deleted && <button className="linkbtn tiny" onClick={() => del(m)} aria-label="Delete for everyone">Delete</button>}</div>
                </div>
              </div>
            </div>);
        })}
        {!msgs.length && detail && <Empty>No messages yet. Say hello.</Empty>}
        <div ref={bottom} />
      </div>
      {detail && !detail.canPost ? <div className="chat-compose muted small" style={{ justifyContent: 'center' }}>Only the people who run this channel can post here.</div> : (
        <div className="chat-compose">
          <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.odt,.ods"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) sendFile(f); }} />
          <button className="btn quiet small" disabled={!!sending} onClick={() => fileInput.current?.click()} aria-label="Send a photo or document">📎</button>
          <textarea className="input" rows={1} placeholder={notReady.length && detail?.kind === 'DIRECT' ? `${notReady[0].name} has not set up chat yet; they will read this once they do` : 'Message'} value={text}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }} maxLength={8000} />
          <button className="btn small" disabled={!!sending || !text.trim()} onClick={sendText}>{sending === 'file' ? 'Sending file…' : 'Send'}</button>
        </div>)}
      {info && detail && <ConversationInfo detail={detail} user={user} myFingerprint={myFingerprint} onClose={() => setInfo(false)} onChanged={async () => { await refresh(); onChanged(); }} onLeft={() => { setInfo(false); onChanged(); onBack(); }} />}
    </>
  );
}

/** A photo shows inline once opened on this device; a document opens or saves on click. */
function FileBubble({ id, p }: { id: string; p: Extract<cc.Payload, { t: 'file' }> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const image = IMAGE.test(p.mime);
  const fetchOpen = useCallback(async () => {
    const data = new Uint8Array(await (await raw(`/chat/files/${id}`)).arrayBuffer());
    const plain = await cc.openFile(data, p.key, p.iv);
    return URL.createObjectURL(new Blob([plain as unknown as BlobPart], { type: p.mime }));
  }, [id, p]);
  useEffect(() => {
    if (!image) return;
    let u: string | null = null;
    fetchOpen().then((x) => { u = x; setUrl(x); }).catch(() => setUrl(''));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [image, fetchOpen]);
  if (image) return url === null ? <span className="muted small">Opening photo…</span> : url === '' ? <span className="muted small">This photo is no longer available.</span>
    : <a href={url} target="_blank" rel="noreferrer"><img className="bubble-img" src={url} alt={p.name} /></a>;
  return (
    <button className="file-card" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const u = await fetchOpen(); const a = document.createElement('a'); a.href = u; a.download = p.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 30_000); }
      catch { await tell('This file is no longer available.'); } finally { setBusy(false); }
    }}>
      <span className="file-icon">{(p.name.split('.').pop() ?? 'FILE').toUpperCase().slice(0, 4)}</span>
      <span style={{ minWidth: 0, textAlign: 'left' }}><span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{p.name}</span><span className="tiny muted">{sizeLabel(p.size)} · {busy ? 'opening…' : 'tap to open'}</span></span>
    </button>
  );
}

function ConversationInfo({ detail, user, myFingerprint, onClose, onChanged, onLeft }: { detail: Detail; user: User; myFingerprint: string; onClose: () => void; onChanged: () => Promise<void>; onLeft: () => void }) {
  const { run, busy } = useAction();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(detail.title);
  const manage = detail.kind === 'GROUP' && !detail.auto && detail.myRole === 'ADMIN';
  const sorted = useMemo(() => [...detail.members].sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : 0)), [detail.members, user.id]);
  return (
    <Drawer title={detail.kind === 'DIRECT' ? 'Chat info' : detail.kind === 'CHANNEL' ? 'Channel info' : 'Group info'} onClose={onClose}>
      {manage && <section className="tile tight stack small">
        <label className="field"><span>Group name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <div><button className="btn quiet small" disabled={busy || name.trim() === detail.title || name.trim().length < 2} onClick={async () => { if (await run(() => api(`/chat/conversations/${detail.id}`, { method: 'PUT', body: { title: name } }), 'Renamed')) await onChanged(); }}>Rename</button></div>
      </section>}
      <section className="tile tight stack small">
        <div style={{ display: 'flex', alignItems: 'center' }}><strong>{detail.members.length} {detail.members.length === 1 ? 'person' : 'people'}</strong><span className="spacer" style={{ flex: 1 }} />
          {manage && <button className="btn quiet small" onClick={() => setAdding(true)}>Add people</button>}</div>
        {detail.auto && <span className="muted">Members follow the staff lists: people join and leave with their posting.</span>}
        {sorted.map((m) => (
          <div key={m.id} className="list-row" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
            <span className="avatar" style={{ width: 34, height: 34, fontSize: '0.7rem' }}>{initials(m.name)}</span>
            <span><strong>{m.id === user.id ? 'You' : m.name}</strong>{m.role === 'ADMIN' && detail.kind !== 'DIRECT' && <span className="pill" style={{ marginLeft: 6 }}>admin</span>}
              <span className="tiny muted" style={{ display: 'block' }}>{m.designation ?? ''}{m.designation ? ' · ' : ''}{m.unit}</span>
              <span className="tiny muted mono" style={{ display: 'block' }}>{m.fingerprint ? `Security code ${m.fingerprint}` : 'Has not set up chat yet'}</span></span>
            {manage && m.id !== user.id && <span style={{ display: 'flex', gap: 6, flexDirection: 'column', alignItems: 'flex-end' }}>
              <button className="linkbtn tiny" disabled={busy} onClick={async () => { if (await run(() => api(`/chat/conversations/${detail.id}/members/${m.id}`, { method: 'PUT', body: { role: m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' } }))) await onChanged(); }}>{m.role === 'ADMIN' ? 'Remove admin' : 'Make admin'}</button>
              <button className="linkbtn tiny" style={{ color: 'var(--red)' }} disabled={busy} onClick={async () => { if (await ask(`Remove ${m.name}?`) && await run(() => api(`/chat/conversations/${detail.id}/members/${m.id}`, { method: 'DELETE' }), 'Removed; the group key changes')) await onChanged(); }}>Remove</button>
            </span>}
          </div>))}
      </section>
      <section className="tile tight stack small">
        <strong>Check you are talking to the right people</strong>
        <span className="muted">Each person has a security code. Read yours to a colleague (in person or on a call) and compare it with what their screen shows for you. If they match, nobody is in between.</span>
        <span>Your code: <span className="mono">{myFingerprint}</span></span>
      </section>
      {detail.kind === 'GROUP' && !detail.auto && <section className="tile tight"><button className="btn danger small" disabled={busy} onClick={async () => { if (await ask('Leave this group?') && await run(() => api(`/chat/conversations/${detail.id}/members/${user.id}`, { method: 'DELETE' }), 'You left the group')) onLeft(); }}>Leave group</button></section>}
      {adding && <PeoplePicker title="Add people" multi exclude={detail.members.map((m) => m.id)} onClose={() => setAdding(false)}
        onPick={async (ids) => { await api(`/chat/conversations/${detail.id}/members`, { body: { userIds: ids } }); setAdding(false); await onChanged(); }} />}
    </Drawer>
  );
}
