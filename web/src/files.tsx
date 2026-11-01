import { useRef, useState } from 'react';
import { api, apiFile, readBase64, time } from './api';
import { ask, useAction, useLoad } from './ui';

/**
 * Files kept with a record (meeting papers, evidence for an action or an inspection, a notice's
 * attachment…): PDF or pictures up to 5 MB. Anyone who sees the record opens them; who may add or
 * remove them is decided by the server for each kind of record.
 */
export function Files({ kind, id, canAdd, title = 'Files', hint }: { kind: string; id: string; canAdd: boolean; title?: string; hint?: string }) {
  const list = useLoad<{ id: string; name: string; content_type: string; size: number; uploaded_at: string; uploaded_by: string }[]>(`/attachments?refKind=${kind}&refId=${id}`, [kind, id]);
  const { run, busy } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const open = async (fid: string) => {
    const { blob } = await apiFile(`/attachments/${fid}/file`);
    const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000);
  };
  const add = async (f?: File) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { await run(() => Promise.reject(new Error('Files must be 5 MB or smaller.'))); return; }
    setAdding(true);
    if (await run(async () => api('/attachments', { body: { refKind: kind, refId: id, name: f.name, dataBase64: await readBase64(f) } }), 'File added')) list.reload();
    setAdding(false);
    if (input.current) input.current.value = '';
  };
  const files = list.data ?? [];
  if (!canAdd && !files.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b className="small">{title}</b>
        {canAdd && <><button className="linkbtn small" disabled={busy || adding} onClick={() => input.current?.click()}>{adding ? 'Adding…' : 'Add a file'}</button>
          <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden onChange={(e) => add(e.target.files?.[0])} /></>}</div>
      {hint && canAdd && !files.length && <span className="tiny muted">{hint}</span>}
      {files.map((f) => <div key={f.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button className="linkbtn small" onClick={() => run(() => open(f.id))}>{f.name}</button>
        <span className="tiny muted">{Math.max(1, Math.round(f.size / 1024))} KB · {f.uploaded_by} · {time(f.uploaded_at)}</span>
        {canAdd && <button className="linkbtn tiny" disabled={busy} onClick={async () => { if (await ask(`Remove “${f.name}”?`) && await run(() => api(`/attachments/${f.id}`, { method: 'DELETE' }), 'Removed')) list.reload(); }}>Remove</button>}
      </div>)}
    </div>
  );
}
