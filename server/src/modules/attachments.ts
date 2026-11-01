import type { Db } from '../db/client.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertStudentAccess } from './access.js';
import { assertTeaches } from './sections.js';
import * as governance from './governance.js';
import * as inspections from './inspections.js';
import * as notices from './notices.js';

/**
 * Files attached to homework, notices, leave requests and student records. Who may see or add a
 * file always follows the record it belongs to. The file's own signature decides its type, so a
 * script renamed to .pdf is refused; files are never edited, only removed (and kept for audit).
 */
export type RefKind = 'homework' | 'notice' | 'leave' | 'student' | 'meeting' | 'action' | 'inspection';

function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Meeting papers (added by the convener, read by whoever sees the meeting), evidence for an action
 * (added by its owner) and inspection evidence (added by the inspectors, or by the principal for a
 * response), each read by whoever may see the record.
 */
async function governed(db: Db, actor: Actor, kind: 'meeting' | 'action' | 'inspection', refId: string, write: boolean) {
  if (kind === 'meeting') {
    const m = await governance.meeting(db, actor, refId);
    if (write && !m.rights.run) throw forbidden('The convener adds the meeting papers.');
    return;
  }
  if (kind === 'action') {
    const a = await db.maybeOne<{ decision_id: string; owner_id: string }>('select decision_id, owner_id from decision_action where id = $1', [refId]);
    if (!a) throw notFound('Action');
    const d = await governance.decision(db, actor, a.decision_id);
    if (write && a.owner_id !== actor.id && !d.rights.progress) throw forbidden('The action’s owner adds its evidence.');
    return;
  }
  const i = await inspections.inspection(db, actor, refId);
  if (write && !i.rights.rate && !i.rights.respond) throw forbidden('Evidence is added by the inspectors, or by the principal when responding.');
}

async function canWrite(db: Db, actor: Actor, kind: RefKind, refId: string) {
  if (kind === 'meeting' || kind === 'action' || kind === 'inspection') return governed(db, actor, kind, refId, true);
  if (kind === 'homework') {
    const h = await db.maybeOne<{ section_id: string; created_by: string; withdrawn_at: string | null }>('select section_id, created_by, withdrawn_at from homework where id = $1', [refId]);
    if (!h) throw notFound('Homework');
    if (h.withdrawn_at) throw invalid('This homework has been withdrawn.');
    await assertTeaches(db, actor, h.section_id);
    return;
  }
  if (kind === 'notice') {
    const n = await db.maybeOne<{ unit_id: string; created_by: string }>('select unit_id, created_by from notice where id = $1', [refId]);
    if (!n) throw notFound('Notice');
    if (!['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(actor.role)) throw forbidden();
    await assertUnitInScope(db, actor, n.unit_id);
    return;
  }
  if (kind === 'leave') {
    const l = await db.maybeOne<{ student_id: string; status: string }>('select student_id, status from leave_request where id = $1', [refId]);
    if (!l) throw notFound('Leave request');
    if (actor.role !== 'PARENT') throw forbidden('Parents attach certificates to their own leave requests.');
    await assertStudentAccess(db, actor, l.student_id, 'leave');
    return;
  }
  if (kind === 'student') {
    if (actor.role === 'PARENT') throw forbidden();
    await assertStudentAccess(db, actor, refId, 'documents');
  }
}

async function canRead(db: Db, actor: Actor, kind: RefKind, refId: string) {
  if (kind === 'meeting' || kind === 'action' || kind === 'inspection') return governed(db, actor, kind, refId, false);
  if (kind === 'homework') {
    const h = await db.maybeOne<{ section_id: string }>('select section_id from homework where id = $1', [refId]);
    if (!h) throw notFound('Homework');
    if (actor.role === 'PARENT') {
      const ok = await db.maybeOne(`select 1 from enrolment e join student_guardian sg on sg.student_id = e.student_id
                                     where e.section_id = $1 and upper_inf(e.period) and sg.guardian_id = $2`, [h.section_id, actor.guardianId]);
      if (!ok) throw forbidden();
      return;
    }
    const s = await db.one<{ school_id: string }>('select c.parent_id as school_id from section s join org_unit c on c.id = s.campus_id where s.id = $1', [h.section_id]);
    await assertUnitInScope(db, actor, s.school_id);
    return;
  }
  if (kind === 'notice') {
    if (actor.role === 'PARENT') {
      const kids = await db.query<{ student_id: string }>('select student_id from student_guardian where guardian_id = $1', [actor.guardianId]);
      for (const k of kids) if ((await notices.forStudent(db, actor, k.student_id).catch(() => [])).some((n) => n.id === refId)) return;
      throw forbidden();
    }
    await notices.one(db, actor, refId);
    return;
  }
  if (kind === 'leave') {
    const l = await db.maybeOne<{ student_id: string }>('select student_id from leave_request where id = $1', [refId]);
    if (!l) throw notFound('Leave request');
    await assertStudentAccess(db, actor, l.student_id, 'leave');
    return;
  }
  if (actor.role === 'PARENT') throw forbidden();
  await assertStudentAccess(db, actor, refId, 'documents');
}

export async function upload(db: Db, actor: Actor, input: { refKind: RefKind; refId: string; name: string; dataBase64: string }) {
  await canWrite(db, actor, input.refKind, input.refId);
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (!buf.length) throw invalid('The file is empty.');
  if (buf.length > 5 * 1024 * 1024) throw invalid('Files must be 5 MB or smaller.');
  const type = sniff(buf);
  if (!type) throw invalid('Only PDF, PNG, JPEG and WebP files are accepted.');
  const name = input.name.replace(/[^\w.\- ()]+/g, '_').slice(0, 160) || 'file';
  return db.tx((t) => t.one<{ id: string }>(
    `insert into attachment (ref_kind, ref_id, name, content_type, bytes, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id, name, content_type`,
    [input.refKind, input.refId, name, type, buf, actor.id]), { actor: actor.label });
}

export async function list(db: Db, actor: Actor, kind: RefKind, refId: string) {
  await canRead(db, actor, kind, refId);
  return db.query(`select a.id, a.name, a.content_type, octet_length(a.bytes) as size, a.uploaded_at, u.name as uploaded_by from attachment a join app_user u on u.id = a.uploaded_by
                    where a.ref_kind = $1 and a.ref_id = $2 and a.removed_at is null order by a.uploaded_at`, [kind, refId]);
}

export async function download(db: Db, actor: Actor, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('File');
  const a = await db.maybeOne<{ ref_kind: RefKind; ref_id: string; name: string; content_type: string; bytes: Uint8Array }>(
    'select ref_kind, ref_id, name, content_type, bytes from attachment where id = $1 and removed_at is null', [id]);
  if (!a) throw notFound('File');
  await canRead(db, actor, a.ref_kind, a.ref_id);
  return a;
}

export async function remove(db: Db, actor: Actor, id: string) {
  const a = await db.maybeOne<{ ref_kind: RefKind; ref_id: string }>('select ref_kind, ref_id from attachment where id = $1 and removed_at is null', [id]);
  if (!a) throw notFound('File');
  await canWrite(db, actor, a.ref_kind, a.ref_id);
  await db.tx((t) => t.query('update attachment set removed_at = now() where id = $1', [id]), { actor: actor.label });
  return { ok: true };
}
