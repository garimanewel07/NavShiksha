import type { Db } from '../db/client.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { localToday } from '../lib/dates.js';
import { newDocument, Sheet, fmtDate } from '../lib/pdf.js';
import type { Actor } from './auth.js';
import { assertUnitInScope } from './auth.js';
import { assertCan, can } from './access.js';
import { post, signed } from './ledger.js';
import * as notify from './notify.js';

/**
 * Stores and assets. Departments raise indents; the principal approves; the store keeper issues
 * from stock or orders (a purchase order approved by someone other than whoever prepared it);
 * goods received go into stock (with batches and expiry dates) or onto the asset register with a
 * QR tag, and into the school's books; the accountant pays the supplier. Balances are always the
 * sum of movements. Assets are audited by scanning their tags, maintained on schedules,
 * depreciated each year and written off with the loss or sale in the books.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const today = () => localToday();
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

async function store(db: Db, actor: Actor, schoolId: string) { await assertCan(db, actor, 'stores.manage', schoolId); }

// ── Items and stock ───────────────────────────────────────────────────────────────────────

export interface ItemInput { code: string; name: string; category: string; kind: 'CONSUMABLE' | 'ASSET'; unit?: string; reorderLevel?: number; trackExpiry?: boolean; lifeYears?: number | null; attributes?: Record<string, string> }

export async function saveItem(db: Db, actor: Actor, schoolId: string, input: ItemInput & { id?: string; active?: boolean }) {
  await store(db, actor, schoolId);
  if (input.kind === 'ASSET' && input.trackExpiry) throw invalid('Assets do not expire; use a consumable for things with an expiry date.');
  return db.tx(async (t) => {
    if (input.id) {
      const r = await t.query(`update store_item set code = $3, name = $4, category = $5, unit = $6, reorder_level = $7, track_expiry = $8, life_years = $9, attributes = $10, active = coalesce($11, active)
                                where id = $1 and school_id = $2 returning id`,
        [input.id, schoolId, input.code.trim().toUpperCase(), input.name.trim(), input.category, input.unit ?? 'nos', input.reorderLevel ?? 0, !!input.trackExpiry, input.lifeYears ?? null, JSON.stringify(input.attributes ?? {}), input.active ?? null]);
      if (!r.length) throw notFound('Item');
      return { id: input.id };
    }
    return t.one<{ id: string }>(`insert into store_item (school_id, code, name, category, kind, unit, reorder_level, track_expiry, life_years, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [schoolId, input.code.trim().toUpperCase(), input.name.trim(), input.category, input.kind, input.unit ?? 'nos', input.reorderLevel ?? 0, !!input.trackExpiry, input.lifeYears ?? null, JSON.stringify(input.attributes ?? {})]);
  }, { actor: actor.label });
}

/** Items with their balance, value, and the earliest expiry still in stock. */
export async function items(db: Db, actor: Actor, schoolId: string) {
  if (!(await can(db, actor, 'stores.view', schoolId))) {
    await assertUnitInScope(db, actor, schoolId);
    // Anyone raising an indent sees the item list (without values).
    return db.query(`select id, code, name, category, kind, unit from store_item where school_id = $1 and active order by category, name`, [schoolId]);
  }
  return db.query(
    `select i.id, i.code, i.name, i.category, i.kind, i.unit, i.reorder_level::float, i.track_expiry, i.life_years, i.attributes, i.active,
            coalesce(b.qty, 0)::float as balance, coalesce(b.value, 0)::float as value_paise, coalesce(b.qty, 0) < i.reorder_level and i.kind = 'CONSUMABLE' as low,
            (select min(x.expiry)::text from (select batch, expiry, sum(qty) as left from stock_movement m where m.item_id = i.id and expiry is not null group by batch, expiry) x where x.left > 0) as next_expiry,
            (select count(*) from asset a where a.item_id = i.id and a.status <> 'DISPOSED')::int as assets
       from store_item i left join (select item_id, sum(qty) as qty, sum(qty * coalesce(unit_paise, 0)) as value from stock_movement group by item_id) b on b.item_id = i.id
      where i.school_id = $1 order by i.active desc, i.category, i.name`, [schoolId]);
}

async function balance(t: Db, itemId: string) {
  return Number((await t.one<{ q: string }>('select coalesce(sum(qty), 0) as q from stock_movement where item_id = $1', [itemId])).q);
}

/**
 * Takes stock out of the store inside the caller's transaction (also used by the infirmary).
 * Items with expiry dates go first-expiry-first-out, batch by batch; expired batches are never issued.
 */
export async function issueIn(t: Db, actor: Actor, schoolId: string, input: { itemId: string; qty: number; department: string; issuedTo?: string | null; note?: string; refType?: string; refId?: string }) {
  const it = await t.maybeOne<{ school_id: string; name: string; kind: string; track_expiry: boolean; unit: string; reorder_level: string }>('select school_id, name, kind, track_expiry, unit, reorder_level from store_item where id = $1', [input.itemId]);
  if (!it || it.school_id !== schoolId) throw notFound('Item');
  if (it.kind === 'ASSET') throw invalid('Assets are given to a custodian on the asset register, not issued from stock.');
  if (!(input.qty > 0)) throw invalid('Give a quantity.');
  const have = await balance(t, input.itemId);
  if (have < input.qty) throw conflict('short', `Only ${have} ${it.unit} of ${it.name} in stock.`);
  const lines: { qty: number; batch: string | null; expiry: string | null; unit: number | null }[] = [];
  if (it.track_expiry) {
    const batches = await t.query<{ batch: string | null; expiry: string | null; left: string; unit: string | null }>(
      `select batch, expiry::text, sum(qty) as left, max(unit_paise) as unit from stock_movement where item_id = $1 group by batch, expiry having sum(qty) > 0 order by expiry nulls last`, [input.itemId]);
    let need = input.qty;
    for (const b of batches) {
      if (need <= 0) break;
      if (b.expiry && b.expiry < today()) continue;
      const take = Math.min(need, Number(b.left));
      lines.push({ qty: take, batch: b.batch, expiry: b.expiry, unit: b.unit === null ? null : Number(b.unit) });
      need -= take;
    }
    if (need > 0) throw conflict('expired', `Not enough unexpired stock of ${it.name}.`);
  } else {
    const avg = await t.one<{ u: string | null }>('select (sum(qty * unit_paise) filter (where qty > 0) / nullif(sum(qty) filter (where qty > 0 and unit_paise is not null), 0))::bigint as u from stock_movement where item_id = $1', [input.itemId]);
    lines.push({ qty: input.qty, batch: null, expiry: null, unit: avg.u === null ? null : Number(avg.u) });
  }
  for (const l of lines) await t.query(
    `insert into stock_movement (item_id, school_id, kind, qty, batch, expiry, unit_paise, department, issued_to, ref_type, ref_id, note, by_user) values ($1,$2,'ISSUE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [input.itemId, schoolId, -l.qty, l.batch, l.expiry, l.unit, input.department.trim(), input.issuedTo ?? null, input.refType ?? null, input.refId ?? null, input.note ?? null, actor.id]);
  const left = have - input.qty;
  if (left < Number(it.reorder_level) && have >= Number(it.reorder_level)) {
    const keepers = await t.query<{ id: string }>(`select user_id as id from duty where school_id = $1 and code = 'STORE_KEEPER' and valid @> current_date`, [schoolId]);
    await notify.toUsers(t, keepers.map((k) => k.id), { kind: 'STORES', title: `${it.name} is running low`, body: `${left} ${it.unit} left (reorder at ${Number(it.reorder_level)}).`, link: '/stores' });
  }
  return { issued: input.qty, left };
}

export async function issue(db: Db, actor: Actor, schoolId: string, input: Parameters<typeof issueIn>[3]) {
  await store(db, actor, schoolId);
  return db.tx((t) => issueIn(t, actor, schoolId, input), { actor: actor.label });
}

/** Stock coming back, an opening balance, or a correction after counting (with the reason). */
export async function adjust(db: Db, actor: Actor, schoolId: string, input: { itemId: string; kind: 'RETURN' | 'ADJUST' | 'OPENING'; qty: number; batch?: string; expiry?: string | null; unitPaise?: number | null; note: string }) {
  await store(db, actor, schoolId);
  const it = await db.maybeOne<{ school_id: string; kind: string }>('select school_id, kind from store_item where id = $1', [input.itemId]);
  if (!it || it.school_id !== schoolId) throw notFound('Item');
  if (it.kind === 'ASSET') throw invalid('Assets are kept on the asset register.');
  if (!input.qty) throw invalid('Give a quantity.');
  if (input.kind !== 'ADJUST' && input.qty < 0) throw invalid('Returns and opening stock add to the store.');
  if (input.note.trim().length < 3) throw invalid('Say why.');
  return db.tx(async (t) => {
    if (input.qty < 0 && (await balance(t, input.itemId)) + input.qty < 0) throw conflict('short', 'That would take the stock below zero.');
    await t.query(`insert into stock_movement (item_id, school_id, kind, qty, batch, expiry, unit_paise, note, by_user) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.itemId, schoolId, input.kind, input.qty, input.batch ?? null, input.expiry ?? null, input.unitPaise ?? null, input.note.trim(), actor.id]);
    return { balance: await balance(t, input.itemId) };
  }, { actor: actor.label });
}

export async function ledgerOf(db: Db, actor: Actor, itemId: string) {
  const it = await db.maybeOne<{ school_id: string }>('select school_id from store_item where id = $1', [itemId]);
  if (!it) throw notFound('Item');
  await assertCan(db, actor, 'stores.view', it.school_id);
  return db.query(`select m.at, m.kind, m.qty::float, m.batch, m.expiry::text, m.unit_paise::float, m.department, u.name as issued_to, m.ref_type, m.ref_id, m.note, b.name as by,
                          sum(m.qty) over (order by m.at, m.id)::float as balance
                     from stock_movement m left join app_user u on u.id = m.issued_to join app_user b on b.id = m.by_user where m.item_id = $1 order by m.at desc, m.id desc limit 300`, [itemId]);
}

// ── Indents ───────────────────────────────────────────────────────────────────────────────

/** Any member of staff asks for things for their department. */
export async function raiseIndent(db: Db, actor: Actor, schoolId: string, input: { department: string; purpose?: string; neededBy?: string | null; lines: { itemId?: string | null; description?: string; qty: number; estPaise?: number }[] }) {
  await assertUnitInScope(db, actor, schoolId);
  if (['PARENT', 'CANDIDATE', 'ALUMNUS', 'SUPPORT', 'DEVELOPER'].includes(actor.role)) throw forbidden();
  if (!input.lines.length) throw invalid('Add what is needed.');
  return db.tx(async (t) => {
    const r = await t.one<{ id: string; number: string }>(`insert into indent (school_id, department, purpose, needed_by, requested_by) values ($1,$2,$3,$4,$5) returning id, number`,
      [schoolId, input.department.trim(), input.purpose?.trim() ?? '', input.neededBy ?? null, actor.id]);
    for (const l of input.lines) {
      let desc = l.description?.trim() ?? '';
      if (l.itemId) {
        const it = await t.maybeOne<{ name: string; school_id: string }>('select name, school_id from store_item where id = $1', [l.itemId]);
        if (!it || it.school_id !== schoolId) throw invalid('Choose items from this school’s list.');
        desc ||= it.name;
      }
      if (!desc) throw invalid('Describe each thing needed.');
      await t.query(`insert into indent_line (indent_id, item_id, description, qty, est_paise) values ($1,$2,$3,$4,$5)`, [r.id, l.itemId ?? null, desc, l.qty, l.estPaise ?? 0]);
    }
    const heads = await t.query<{ id: string }>(`select u.id from app_user u join org_unit o on o.id = $1 where u.active and u.role = 'SCHOOL_ADMIN' and u.scope_path <@ o.path`, [schoolId]);
    await notify.toUsers(t, heads.map((h) => h.id), { kind: 'STORES', title: `${r.number}: an indent from ${input.department.trim()}`, link: '/stores' });
    return r;
  }, { actor: actor.label });
}

export async function indents(db: Db, actor: Actor, schoolId: string) {
  await assertUnitInScope(db, actor, schoolId);
  const all = await can(db, actor, 'stores.view', schoolId) || actor.role === 'SCHOOL_ADMIN';
  return db.query(
    `select i.id, i.number, i.department, i.purpose, i.needed_by::text, i.status, i.created_at, u.name as requested_by, d.name as decided_by, i.decision_note,
            (select jsonb_agg(jsonb_build_object('id', l.id, 'itemId', l.item_id, 'description', l.description, 'qty', l.qty::float, 'estPaise', l.est_paise, 'balance',
                    (select coalesce(sum(m.qty), 0)::float from stock_movement m where m.item_id = l.item_id)) order by l.description) from indent_line l where l.indent_id = i.id) as lines
       from indent i join app_user u on u.id = i.requested_by left join app_user d on d.id = i.decided_by
      where i.school_id = $1 and ($2 or i.requested_by = $3) order by i.created_at desc limit 200`, [schoolId, all, actor.id]);
}

export async function decideIndent(db: Db, actor: Actor, id: string, approve: boolean, note?: string) {
  const i = await db.maybeOne<{ school_id: string; status: string; requested_by: string; number: string }>('select school_id, status, requested_by, number from indent where id = $1', [id]);
  if (!i) throw notFound('Indent');
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal approves indents.');
  await assertUnitInScope(db, actor, i.school_id);
  if (i.status !== 'SUBMITTED') throw conflict('decided', 'Already decided.');
  if (!approve && !note?.trim()) throw invalid('Give the reason.');
  await db.tx(async (t) => {
    await t.query(`update indent set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note?.trim() || null]);
    await notify.toUsers(t, [i.requested_by], { kind: 'STORES', title: `${i.number} ${approve ? 'approved' : 'not approved'}`, body: note ?? '', link: '/stores' });
  }, { actor: actor.label });
  return { status: approve ? 'APPROVED' : 'REJECTED' };
}

/** The store keeper issues an approved indent from stock (what is in stock; the rest can be ordered). */
export async function issueIndent(db: Db, actor: Actor, id: string) {
  const i = await db.maybeOne<{ school_id: string; status: string; department: string; requested_by: string; number: string }>('select school_id, status, department, requested_by, number from indent where id = $1', [id]);
  if (!i) throw notFound('Indent');
  await store(db, actor, i.school_id);
  if (i.status !== 'APPROVED') throw conflict('state', 'Only an approved indent is issued.');
  return db.tx(async (t) => {
    const lines = await t.query<{ item_id: string | null; qty: string; description: string }>('select item_id, qty, description from indent_line where indent_id = $1', [id]);
    const short: string[] = [];
    for (const l of lines) {
      if (!l.item_id) { short.push(l.description); continue; }
      const have = await balance(t, l.item_id);
      const q = Math.min(have, Number(l.qty));
      if (q > 0) await issueIn(t, actor, i.school_id, { itemId: l.item_id, qty: q, department: i.department, issuedTo: i.requested_by, refType: 'indent', refId: i.number });
      if (q < Number(l.qty)) short.push(l.description);
    }
    await t.query(`update indent set status = $2 where id = $1`, [id, short.length ? 'APPROVED' : 'ISSUED']);
    await notify.toUsers(t, [i.requested_by], { kind: 'STORES', title: `${i.number}: ready to collect from the store`, body: short.length ? `To be ordered: ${short.join(', ')}` : '', link: '/stores' });
    return { short };
  }, { actor: actor.label });
}

// ── Suppliers, purchase orders and receipts ───────────────────────────────────────────────

export async function saveSupplier(db: Db, actor: Actor, schoolId: string, input: { id?: string; name: string; gstin?: string | null; phone?: string; email?: string; address?: string }) {
  await store(db, actor, schoolId);
  return db.tx((t) => input.id
    ? t.one<{ id: string }>(`update supplier set name = $3, gstin = $4, phone = $5, email = $6, address = $7 where id = $1 and school_id = $2 returning id`, [input.id, schoolId, input.name.trim(), input.gstin?.trim().toUpperCase() || null, input.phone ?? null, input.email ?? null, input.address ?? null])
    : t.one<{ id: string }>(`insert into supplier (school_id, name, gstin, phone, email, address) values ($1,$2,$3,$4,$5,$6) returning id`, [schoolId, input.name.trim(), input.gstin?.trim().toUpperCase() || null, input.phone ?? null, input.email ?? null, input.address ?? null]),
  { actor: actor.label });
}

export async function suppliers(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'stores.view', schoolId);
  return db.query(`select s.*, (select coalesce(sum(g.amount_paise - g.paid_paise), 0) from goods_receipt g join purchase_order p on p.id = g.po_id where p.supplier_id = s.id)::float as owed_paise from supplier s where s.school_id = $1 order by name`, [schoolId]);
}

const poTotal = (lines: { qty: number; unitPaise: number; gstPct?: number }[]) => Math.round(lines.reduce((s, l) => s + l.qty * l.unitPaise * (1 + (l.gstPct ?? 0) / 100), 0));

/** The store keeper prepares a purchase order (from an approved indent, or for restocking). */
export async function createPo(db: Db, actor: Actor, schoolId: string, input: { supplierId: string; indentId?: string | null; terms?: string; lines: { itemId: string; qty: number; unitPaise: number; gstPct?: number }[] }) {
  await store(db, actor, schoolId);
  if (!input.lines.length) throw invalid('Add the items.');
  const s = await db.maybeOne<{ school_id: string }>('select school_id from supplier where id = $1', [input.supplierId]);
  if (!s || s.school_id !== schoolId) throw invalid('Choose a supplier of this school.');
  if (input.indentId) {
    const ind = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from indent where id = $1', [input.indentId]);
    if (!ind || ind.school_id !== schoolId || ind.status !== 'APPROVED') throw invalid('Order against an approved indent of this school.');
  }
  return db.tx(async (t) => {
    const p = await t.one<{ id: string; number: string }>(`insert into purchase_order (school_id, supplier_id, indent_id, terms, total_paise, prepared_by) values ($1,$2,$3,$4,$5,$6) returning id, number`,
      [schoolId, input.supplierId, input.indentId ?? null, input.terms?.trim() ?? '', poTotal(input.lines), actor.id]);
    for (const l of input.lines) {
      const it = await t.maybeOne<{ school_id: string }>('select school_id from store_item where id = $1', [l.itemId]);
      if (!it || it.school_id !== schoolId) throw invalid('Choose items from this school’s list.');
      await t.query(`insert into po_line (po_id, item_id, qty, unit_paise, gst_pct) values ($1,$2,$3,$4,$5)`, [p.id, l.itemId, l.qty, l.unitPaise, l.gstPct ?? 0]);
    }
    if (input.indentId) await t.query(`update indent set status = 'ORDERED' where id = $1`, [input.indentId]);
    return p;
  }, { actor: actor.label });
}

/** The principal approves and issues the order (never the person who prepared it). */
export async function approvePo(db: Db, actor: Actor, id: string) {
  const p = await db.maybeOne<{ school_id: string; status: string; prepared_by: string }>('select school_id, status, prepared_by from purchase_order where id = $1', [id]);
  if (!p) throw notFound('Purchase order');
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal approves purchase orders.');
  await assertUnitInScope(db, actor, p.school_id);
  if (p.prepared_by === actor.id) throw forbidden('Someone other than whoever prepared the order approves it.');
  if (p.status !== 'DRAFT') throw conflict('state', 'Only a draft is approved.');
  await db.tx((t) => t.query(`update purchase_order set status = 'ISSUED', approved_by = $2, issued_at = now() where id = $1`, [id, actor.id]), { actor: actor.label });
  return { status: 'ISSUED' };
}

export async function orders(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'stores.view', schoolId);
  return db.query(
    `select p.id, p.number, p.status, p.total_paise::float, p.terms, p.created_at, p.issued_at, s.name as supplier, s.id as supplier_id, i.number as indent, a.name as prepared_by, b.name as approved_by,
            (select jsonb_agg(jsonb_build_object('id', l.id, 'itemId', l.item_id, 'item', it.name, 'unit', it.unit, 'kind', it.kind, 'trackExpiry', it.track_expiry, 'qty', l.qty::float, 'unitPaise', l.unit_paise, 'gstPct', l.gst_pct::float, 'received', l.received::float) order by it.name)
               from po_line l join store_item it on it.id = l.item_id where l.po_id = p.id) as lines,
            (select jsonb_agg(jsonb_build_object('id', g.id, 'number', g.number, 'receivedOn', g.received_on, 'invoiceNo', g.invoice_no, 'amount', g.amount_paise, 'paid', g.paid_paise) order by g.received_on) from goods_receipt g where g.po_id = p.id) as receipts
       from purchase_order p join supplier s on s.id = p.supplier_id left join indent i on i.id = p.indent_id join app_user a on a.id = p.prepared_by left join app_user b on b.id = p.approved_by
      where p.school_id = $1 order by p.created_at desc limit 200`, [schoolId]);
}

/**
 * Goods received against an order: consumables into stock (with batch and expiry), assets onto the
 * register with tags, and the invoice into the books (stores expense or fixed assets, owed to the supplier).
 */
export async function receive(db: Db, actor: Actor, poId: string, input: { receivedOn: string; invoiceNo: string; invoiceDate?: string; lines: { lineId: string; qty: number; batch?: string; expiry?: string | null; serials?: string[]; location?: string }[] }) {
  const p = await db.maybeOne<{ school_id: string; status: string; number: string; supplier: string; code: string }>(
    `select p.school_id, p.status, p.number, s.name as supplier, o.code from purchase_order p join supplier s on s.id = p.supplier_id join org_unit o on o.id = p.school_id where p.id = $1`, [poId]);
  if (!p) throw notFound('Purchase order');
  await store(db, actor, p.school_id);
  if (!['ISSUED', 'PART_RECEIVED'].includes(p.status)) throw conflict('state', 'Receive goods against an approved, issued order.');
  if (input.receivedOn > today()) throw invalid('The date received cannot be in the future.');
  return db.tx(async (t) => {
    let consumables = 0, assets = 0;
    const g = await t.one<{ id: string; number: string }>(`insert into goods_receipt (po_id, school_id, received_on, invoice_no, invoice_date, amount_paise, received_by) values ($1,$2,$3,$4,$5,0,$6) returning id, number`,
      [poId, p.school_id, input.receivedOn, input.invoiceNo.trim(), input.invoiceDate ?? null, actor.id]);
    for (const r of input.lines) {
      if (!(r.qty > 0)) continue;
      const l = await t.maybeOne<{ item_id: string; qty: string; received: string; unit_paise: string; gst_pct: string; kind: string; track_expiry: boolean; name: string; life_years: number | null }>(
        `select l.item_id, l.qty, l.received, l.unit_paise, l.gst_pct, i.kind, i.track_expiry, i.name, i.life_years from po_line l join store_item i on i.id = l.item_id where l.id = $1 and l.po_id = $2`, [r.lineId, poId]);
      if (!l) throw invalid('That line is not on this order.');
      if (Number(l.received) + r.qty > Number(l.qty)) throw invalid(`More ${l.name} than ordered.`);
      const unit = Math.round(Number(l.unit_paise) * (1 + Number(l.gst_pct) / 100));
      await t.query('update po_line set received = received + $2 where id = $1', [r.lineId, r.qty]);
      if (l.kind === 'ASSET') {
        if (!Number.isInteger(r.qty)) throw invalid('Assets are received in whole numbers.');
        for (let k = 0; k < r.qty; k++) {
          const n = (await t.one<{ n: number }>(`select count(*)::int + 1 as n from asset where school_id = $1`, [p.school_id])).n;
          await t.query(`insert into asset (school_id, tag, item_id, name, serial_no, location, acquired_on, cost_paise, life_years, grn_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [p.school_id, `A-${p.code.replace(/[^A-Z0-9]/g, '')}-${String(n).padStart(5, '0')}`, l.item_id, l.name, r.serials?.[k] ?? null, r.location ?? 'Store', input.receivedOn, unit, l.life_years ?? 5, g.id]);
        }
        assets += unit * r.qty;
      } else {
        if (l.track_expiry && !r.expiry) throw invalid(`Give the expiry date for ${l.name}.`);
        await t.query(`insert into stock_movement (item_id, school_id, kind, qty, batch, expiry, unit_paise, ref_type, ref_id, by_user) values ($1,$2,'RECEIPT',$3,$4,$5,$6,'goods_receipt',$7,$8)`,
          [l.item_id, p.school_id, r.qty, r.batch ?? null, r.expiry ?? null, unit, g.number, actor.id]);
        consumables += unit * r.qty;
      }
    }
    const amount = consumables + assets;
    if (!amount) throw invalid('Enter the quantities received.');
    await t.query('update goods_receipt set amount_paise = $2 where id = $1', [g.id, amount]);
    const left = await t.one<{ n: number }>('select count(*)::int as n from po_line where po_id = $1 and received < qty', [poId]);
    await t.query(`update purchase_order set status = $2 where id = $1`, [poId, left.n ? 'PART_RECEIVED' : 'RECEIVED']);
    await post(t, { schoolId: p.school_id, narration: `${g.number}: goods from ${p.supplier}, invoice ${input.invoiceNo.trim()} (${p.number})`, sourceType: 'goods_receipt', sourceId: g.id, postedOn: input.receivedOn,
      lines: [signed('5400', consumables, 'debit'), signed('1600', assets, 'debit'), signed('2600', amount, 'credit')] });
    return { number: g.number, amount };
  }, { actor: actor.label });
}

/** The accountant pays a supplier's invoice (by bank transfer, with the UTR). */
export async function paySupplier(db: Db, actor: Actor, grnId: string, input: { amountPaise: number; paidOn: string; utr: string }) {
  const g = await db.maybeOne<{ school_id: string; amount_paise: string; paid_paise: string; number: string; supplier: string }>(
    `select g.school_id, g.amount_paise, g.paid_paise, g.number, s.name as supplier from goods_receipt g join purchase_order p on p.id = g.po_id join supplier s on s.id = p.supplier_id where g.id = $1`, [grnId]);
  if (!g) throw notFound('Receipt');
  await assertCan(db, actor, 'stores.pay', g.school_id);
  if (input.amountPaise <= 0 || input.amountPaise > Number(g.amount_paise) - Number(g.paid_paise)) throw invalid(`At most ${rupees(Number(g.amount_paise) - Number(g.paid_paise))} is owed on this invoice.`);
  return db.tx(async (t) => {
    const r = await t.one<{ id: string }>(`insert into supplier_payment (grn_id, amount_paise, paid_on, utr, paid_by) values ($1,$2,$3,$4,$5) returning id`, [grnId, input.amountPaise, input.paidOn, input.utr.trim(), actor.id]);
    await t.query('update goods_receipt set paid_paise = paid_paise + $2 where id = $1', [grnId, input.amountPaise]);
    await post(t, { schoolId: g.school_id, narration: `Paid ${g.supplier} for ${g.number}, UTR ${input.utr.trim()}`, sourceType: 'supplier_payment', sourceId: r.id, postedOn: input.paidOn,
      lines: [signed('2600', input.amountPaise, 'debit'), signed('1100', input.amountPaise, 'credit')] });
    return { id: r.id };
  }, { actor: actor.label });
}

export async function poPdf(db: Db, actor: Actor, id: string) {
  const o = (await db.query<any>(`select p.*, s.name as supplier, s.gstin, s.address as supplier_address, s.phone as supplier_phone, o.name as school, o.address as school_address, a.name as prepared_by, b.name as approved_by
                                    from purchase_order p join supplier s on s.id = p.supplier_id join org_unit o on o.id = p.school_id join app_user a on a.id = p.prepared_by left join app_user b on b.id = p.approved_by where p.id = $1`, [id]))[0];
  if (!o) throw notFound('Purchase order');
  await assertCan(db, actor, 'stores.view', o.school_id);
  const lines = await db.query<{ name: string; unit: string; qty: string; unit_paise: string; gst_pct: string }>(`select i.name, i.unit, l.qty, l.unit_paise, l.gst_pct from po_line l join store_item i on i.id = l.item_id where l.po_id = $1 order by i.name`, [id]);
  const { doc, fonts: f } = await newDocument(`Purchase order ${o.number}`);
  const s = new Sheet(doc, 210, 297, f);
  s.text(o.school, 15, 14, { size: 14, font: f.serifBold, maxWidth: 180 });
  s.text(o.school_address ?? '', 15, 21, { size: 8.5, maxWidth: 180 });
  s.text(`PURCHASE ORDER ${o.number}`, 15, 32, { size: 12, font: f.bold });
  s.text(`${o.status === 'DRAFT' ? 'DRAFT · not approved' : `Issued ${fmtDate(String(o.issued_at).slice(0, 10))}`}`, 15, 38, { size: 9 });
  s.text(`To: ${o.supplier}${o.gstin ? ` (GSTIN ${o.gstin})` : ''}`, 15, 46, { size: 10, font: f.bold, maxWidth: 180 });
  s.text([o.supplier_address, o.supplier_phone].filter(Boolean).join(' · '), 15, 52, { size: 8.5, maxWidth: 180 });
  let y = 62;
  s.rect(15, y - 1, 180, 6, { fill: [0.93, 0.94, 0.96] });
  [['Item', 15, 80], ['Qty', 100, 20], ['Rate', 122, 25], ['GST', 148, 15], ['Amount', 165, 30]].forEach(([l, x, w]) => s.text(l as string, (x as number) + 1, y, { size: 8.5, font: f.bold, maxWidth: w as number }));
  y += 7;
  let total = 0;
  for (const l of lines) {
    const amt = Number(l.qty) * Number(l.unit_paise) * (1 + Number(l.gst_pct) / 100); total += amt;
    s.text(l.name, 16, y, { size: 9, maxWidth: 82 }); s.text(`${Number(l.qty)} ${l.unit}`, 101, y, { size: 9 }); s.text(rupees(Number(l.unit_paise)), 123, y, { size: 9 });
    s.text(`${Number(l.gst_pct)}%`, 149, y, { size: 9 }); s.text(rupees(Math.round(amt)), 166, y, { size: 9 });
    y += 6;
  }
  s.line(15, y, 195, y);
  s.text(`Total ${rupees(Math.round(total))}`, 150, y + 3, { size: 10, font: f.bold });
  if (o.terms) s.text(`Terms: ${o.terms}`, 15, y + 12, { size: 8.5, maxWidth: 180 });
  s.text(`Prepared by ${o.prepared_by}${o.approved_by ? ` · Approved by ${o.approved_by}` : ''}`, 15, y + 22, { size: 8.5 });
  return { name: `${o.number}.pdf`, data: Buffer.from(await doc.save()) };
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────

export async function assets(db: Db, actor: Actor, schoolId: string, q: { status?: string; search?: string } = {}) {
  await assertCan(db, actor, 'stores.view', schoolId);
  return db.query(
    `select a.id, a.tag, a.name, a.serial_no, a.location, a.status, a.acquired_on::text, a.cost_paise::float, a.depreciated_paise::float, a.life_years, u.name as custodian, a.custodian as custodian_id, i.category,
            (select min(m.due_on)::text from asset_maintenance m where m.asset_id = a.id and m.done_on is null) as next_service
       from asset a left join app_user u on u.id = a.custodian left join store_item i on i.id = a.item_id
      where a.school_id = $1 and ($2::text is null or a.status = $2) and ($3::text is null or a.name ilike '%' || $3 || '%' or a.tag ilike '%' || $3 || '%' or a.location ilike '%' || $3 || '%')
      order by a.tag limit 1000`, [schoolId, q.status ?? null, q.search ?? null]);
}

/** Assets already in the school before NavShiksha (the opening register; not put in the books again). */
export async function addAsset(db: Db, actor: Actor, schoolId: string, input: { name: string; itemId?: string | null; serialNo?: string; location: string; acquiredOn: string; costPaise: number; lifeYears?: number; custodian?: string | null }) {
  await store(db, actor, schoolId);
  const code = (await db.one<{ code: string }>('select code from org_unit where id = $1', [schoolId])).code.replace(/[^A-Z0-9]/g, '');
  return db.tx(async (t) => {
    const n = (await t.one<{ n: number }>(`select count(*)::int + 1 as n from asset where school_id = $1`, [schoolId])).n;
    return t.one<{ id: string; tag: string }>(`insert into asset (school_id, tag, item_id, name, serial_no, location, custodian, acquired_on, cost_paise, life_years) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, tag`,
      [schoolId, `A-${code}-${String(n).padStart(5, '0')}`, input.itemId ?? null, input.name.trim(), input.serialNo ?? null, input.location.trim(), input.custodian ?? null, input.acquiredOn, input.costPaise, input.lifeYears ?? 5]);
  }, { actor: actor.label });
}

export async function updateAsset(db: Db, actor: Actor, id: string, input: { location?: string; custodian?: string | null; status?: 'IN_USE' | 'IN_REPAIR' | 'MISSING' }) {
  const a = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from asset where id = $1', [id]);
  if (!a) throw notFound('Asset');
  await store(db, actor, a.school_id);
  if (a.status === 'DISPOSED') throw conflict('disposed', 'This asset has been written off.');
  await db.tx((t) => t.query(`update asset set location = coalesce($2, location), custodian = case when $3 then $4 else custodian end, status = coalesce($5, status) where id = $1`,
    [id, input.location?.trim() ?? null, input.custodian !== undefined, input.custodian ?? null, input.status ?? null]), { actor: actor.label });
  return { ok: true };
}

/** Scanning a tag: the asset, wherever it is. */
export async function byTag(db: Db, actor: Actor, tag: string) {
  const a = await db.maybeOne<{ id: string; school_id: string }>('select id, school_id from asset where tag = $1', [tag.trim().toUpperCase()]);
  if (!a) throw notFound('Asset');
  await assertCan(db, actor, 'stores.view', a.school_id);
  return (await assets(db, actor, a.school_id, { search: tag.trim().toUpperCase() }))[0];
}

/** QR tag labels for assets, on A4 label sheets (3 across, 8 down). */
export async function tagLabels(db: Db, actor: Actor, schoolId: string, ids?: string[]) {
  await assertCan(db, actor, 'stores.view', schoolId);
  const rows = await db.query<{ tag: string; name: string; school: string }>(`select a.tag, a.name, o.name as school from asset a join org_unit o on o.id = a.school_id where a.school_id = $1 and a.status <> 'DISPOSED' and ($2::uuid[] is null or a.id = any($2)) order by a.tag`, [schoolId, ids?.length ? ids : null]);
  const { doc, fonts: f } = await newDocument('Asset tags');
  let s: Sheet | null = null;
  rows.forEach((r, i) => {
    if (i % 24 === 0) s = new Sheet(doc, 210, 297, f);
    const col = i % 3, row = Math.floor((i % 24) / 3), x = 7 + col * 66, y = 12 + row * 34;
    s!.rect(x, y, 64, 32, { stroke: [0.7, 0.7, 0.72], dash: true });
    s!.qr(r.tag, x + 2, y + 3, 26);
    s!.text(r.tag, x + 30, y + 5, { size: 8.5, font: f.mono, maxWidth: 33 });
    s!.text(r.name, x + 30, y + 11, { size: 8, font: f.bold, maxWidth: 33 });
    s!.text(r.school, x + 30, y + 22, { size: 6, maxWidth: 33 });
  });
  if (!rows.length) new Sheet(doc, 210, 297, f).text('No assets.', 20, 20);
  return { name: 'asset-tags.pdf', data: Buffer.from(await doc.save()) };
}

// ── Maintenance ───────────────────────────────────────────────────────────────────────────

export async function scheduleService(db: Db, actor: Actor, assetId: string, input: { kind: string; everyMonths?: number | null; dueOn: string; vendor?: string }) {
  const a = await db.maybeOne<{ school_id: string }>('select school_id from asset where id = $1', [assetId]);
  if (!a) throw notFound('Asset');
  await store(db, actor, a.school_id);
  return db.tx((t) => t.one<{ id: string }>(`insert into asset_maintenance (asset_id, kind, every_months, due_on, vendor) values ($1,$2,$3,$4,$5) returning id`,
    [assetId, input.kind.trim(), input.everyMonths ?? null, input.dueOn, input.vendor ?? null]), { actor: actor.label });
}

/** Service done: recorded, and the next one scheduled when it repeats. */
export async function serviceDone(db: Db, actor: Actor, id: string, input: { doneOn: string; costPaise?: number | null; note?: string }) {
  const m = await db.maybeOne<{ asset_id: string; school_id: string; every_months: number | null; kind: string; vendor: string | null; done_on: string | null }>(
    'select m.asset_id, a.school_id, m.every_months, m.kind, m.vendor, m.done_on from asset_maintenance m join asset a on a.id = m.asset_id where m.id = $1', [id]);
  if (!m) throw notFound('Service');
  await store(db, actor, m.school_id);
  if (m.done_on) throw conflict('done', 'Already recorded.');
  return db.tx(async (t) => {
    await t.query('update asset_maintenance set done_on = $2, cost_paise = $3, note = $4, by_user = $5 where id = $1', [id, input.doneOn, input.costPaise ?? null, input.note ?? null, actor.id]);
    if (m.every_months) await t.query(`insert into asset_maintenance (asset_id, kind, every_months, due_on, vendor) values ($1, $2, $3, ($4::date + ($3 || ' months')::interval)::date, $5)`, [m.asset_id, m.kind, m.every_months, input.doneOn, m.vendor]);
    return { next: !!m.every_months };
  }, { actor: actor.label });
}

export async function servicesDue(db: Db, actor: Actor, schoolId: string, withinDays = 30) {
  await assertCan(db, actor, 'stores.view', schoolId);
  return db.query(`select m.id, m.kind, m.due_on::text, m.vendor, m.every_months, a.tag, a.name, a.location, m.due_on < current_date as overdue from asset_maintenance m join asset a on a.id = m.asset_id
                    where a.school_id = $1 and m.done_on is null and a.status <> 'DISPOSED' and m.due_on <= current_date + $2::int order by m.due_on`, [schoolId, withinDays]);
}

// ── Audits by scanning ────────────────────────────────────────────────────────────────────

export async function startAudit(db: Db, actor: Actor, schoolId: string, title: string) {
  await store(db, actor, schoolId);
  if (await db.maybeOne(`select 1 from stock_audit where school_id = $1 and status = 'OPEN'`, [schoolId])) throw conflict('open', 'An audit is already open.');
  return db.tx((t) => t.one<{ id: string }>(`insert into stock_audit (school_id, title, started_by) values ($1, $2, $3) returning id`, [schoolId, title.trim(), actor.id]), { actor: actor.label });
}

export async function scan(db: Db, actor: Actor, auditId: string, tag: string, location?: string) {
  const a = await db.maybeOne<{ school_id: string; status: string }>('select school_id, status from stock_audit where id = $1', [auditId]);
  if (!a) throw notFound('Audit');
  await store(db, actor, a.school_id);
  if (a.status !== 'OPEN') throw conflict('closed', 'This audit is closed.');
  const asset = await db.maybeOne<{ id: string; name: string; location: string; school_id: string; status: string }>('select id, name, location, school_id, status from asset where tag = $1', [tag.trim().toUpperCase()]);
  if (!asset || asset.school_id !== a.school_id) throw notFound(`Asset ${tag}`);
  await db.tx((t) => t.query(`insert into stock_audit_scan (audit_id, asset_id, location, by_user) values ($1,$2,$3,$4) on conflict (audit_id, asset_id) do update set location = excluded.location, at = now()`,
    [auditId, asset.id, location?.trim() || null, actor.id]), { actor: actor.label });
  return { name: asset.name, registered: asset.location, found: location?.trim() || asset.location, moved: !!location?.trim() && location.trim() !== asset.location, status: asset.status };
}

/** What the audit found: assets not scanned, assets found elsewhere, and the count. */
export async function auditReport(db: Db, actor: Actor, auditId: string) {
  const a = await db.maybeOne<{ school_id: string; title: string; status: string; started_at: string }>('select school_id, title, status, started_at from stock_audit where id = $1', [auditId]);
  if (!a) throw notFound('Audit');
  await assertCan(db, actor, 'stores.view', a.school_id);
  const missing = await db.query(`select a.id, a.tag, a.name, a.location, u.name as custodian from asset a left join app_user u on u.id = a.custodian
                                    where a.school_id = $1 and a.status in ('IN_USE', 'IN_REPAIR') and not exists (select 1 from stock_audit_scan s where s.audit_id = $2 and s.asset_id = a.id) order by a.location, a.tag`, [a.school_id, auditId]);
  const moved = await db.query(`select a.tag, a.name, a.location as registered, s.location as found from stock_audit_scan s join asset a on a.id = s.asset_id where s.audit_id = $1 and s.location is not null and s.location <> a.location`, [auditId]);
  const scanned = (await db.one<{ n: number }>('select count(*)::int as n from stock_audit_scan where audit_id = $1', [auditId])).n;
  return { ...a, scanned, missing, moved };
}

/** Closing an audit: moved assets take their new location; those not found are marked missing. */
export async function closeAudit(db: Db, actor: Actor, auditId: string) {
  const r = await auditReport(db, actor, auditId);
  await store(db, actor, r.school_id);
  if (r.status !== 'OPEN') throw conflict('closed', 'Already closed.');
  await db.tx(async (t) => {
    await t.query(`update asset a set location = s.location from stock_audit_scan s where s.audit_id = $1 and s.asset_id = a.id and s.location is not null`, [auditId]);
    await t.query(`update asset set status = 'MISSING' where id = any($1::uuid[])`, [(r.missing as { id: string }[]).map((m) => m.id)]);
    await t.query(`update stock_audit set status = 'CLOSED', closed_at = now() where id = $1`, [auditId]);
  }, { actor: actor.label });
  return { missing: r.missing.length, moved: r.moved.length };
}

export async function audits(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'stores.view', schoolId);
  return db.query(`select s.id, s.title, s.status, s.started_at, s.closed_at, u.name as by, (select count(*) from stock_audit_scan x where x.audit_id = s.id)::int as scanned from stock_audit s join app_user u on u.id = s.started_by where s.school_id = $1 order by s.started_at desc`, [schoolId]);
}

// ── Depreciation and write-off ────────────────────────────────────────────────────────────

/**
 * The year's depreciation (straight line over each asset's life; a part year from the month it
 * was acquired), posted once per financial year: depreciation expense against accumulated depreciation.
 */
export async function depreciate(db: Db, actor: Actor, schoolId: string, fy: string) {
  await assertCan(db, actor, 'stores.pay', schoolId);
  if (!/^\d{4}-\d{2}$/.test(fy)) throw invalid('Give the financial year, like 2026-27.');
  const start = `${fy.slice(0, 4)}-04-01`, end = `${Number(fy.slice(0, 4)) + 1}-03-31`;
  if (end > today() && fy !== fyOf(today())) throw invalid('Depreciation is for a year that has started.');
  if (await db.maybeOne('select 1 from depreciation_run where school_id = $1 and fy = $2', [schoolId, fy])) throw conflict('done', `Depreciation for ${fy} is already in the books.`);
  return db.tx(async (t) => {
    const list = await t.query<{ id: string; cost_paise: string; depreciated_paise: string; life_years: number; acquired_on: string }>(
      `select id, cost_paise, depreciated_paise, life_years, acquired_on::text from asset where school_id = $1 and status <> 'DISPOSED' and acquired_on <= $2 and depreciated_paise < cost_paise`, [schoolId, end]);
    let total = 0;
    for (const a of list) {
      const yearly = Number(a.cost_paise) / a.life_years;
      const months = a.acquired_on > start ? 12 - ((Number(a.acquired_on.slice(5, 7)) + 8) % 12) : 12;
      const amt = Math.min(Math.round((yearly * months) / 12), Number(a.cost_paise) - Number(a.depreciated_paise));
      if (amt <= 0) continue;
      await t.query('update asset set depreciated_paise = depreciated_paise + $2 where id = $1', [a.id, amt]);
      total += amt;
    }
    const r = await t.one<{ id: string }>(`insert into depreciation_run (school_id, fy, amount_paise, run_by) values ($1,$2,$3,$4) returning id`, [schoolId, fy, total, actor.id]);
    await post(t, { schoolId, narration: `Depreciation on fixed assets for ${fy}`, sourceType: 'depreciation_run', sourceId: r.id, postedOn: end < today() ? end : today(), lines: [signed('5500', total, 'debit'), signed('1690', total, 'credit')] });
    return { assets: list.length, amountPaise: total };
  }, { actor: actor.label });
}

/** Writing an asset off (sold, scrapped or lost): the books take out its cost and depreciation, with any sale and the loss or gain. */
export async function dispose(db: Db, actor: Actor, id: string, input: { on: string; salePaise?: number; note: string }) {
  const a = await db.maybeOne<{ school_id: string; status: string; tag: string; name: string; cost_paise: string; depreciated_paise: string }>('select school_id, status, tag, name, cost_paise, depreciated_paise from asset where id = $1', [id]);
  if (!a) throw notFound('Asset');
  if (actor.role !== 'SCHOOL_ADMIN') throw forbidden('The principal writes assets off.');
  await assertUnitInScope(db, actor, a.school_id);
  if (a.status === 'DISPOSED') throw conflict('done', 'Already written off.');
  if (input.note.trim().length < 5) throw invalid('Give the reason and the order reference.');
  const sale = input.salePaise ?? 0, book = Number(a.cost_paise) - Number(a.depreciated_paise), diff = sale - book;
  await db.tx(async (t) => {
    await t.query(`update asset set status = 'DISPOSED', disposed_on = $2, disposal_paise = $3, disposal_note = $4 where id = $1`, [id, input.on, sale, input.note.trim()]);
    await post(t, { schoolId: a.school_id, narration: `${a.tag} ${a.name} written off: ${input.note.trim()}`, sourceType: 'asset_disposal', sourceId: id, postedOn: input.on,
      lines: [signed('1100', sale, 'debit'), signed('1690', Number(a.depreciated_paise), 'debit'), signed('5510', diff < 0 ? -diff : 0, 'debit'), signed('4910', diff > 0 ? diff : 0, 'credit'), signed('1600', Number(a.cost_paise), 'credit')] });
  }, { actor: actor.label });
  return { bookValue: book, sale, gain: diff };
}

/** The store keeper's overview: low stock, expiring batches, services due, indents waiting, money owed to suppliers. */
export async function overview(db: Db, actor: Actor, schoolId: string) {
  await assertCan(db, actor, 'stores.view', schoolId);
  const list = await items(db, actor, schoolId) as { low: boolean; name: string; balance: number; unit: string; reorder_level: number }[];
  return {
    low: list.filter((i) => i.low),
    expiring: await db.query(`select i.name, x.batch, x.expiry::text, x.left::float, i.unit from (select item_id, batch, expiry, sum(qty) as left from stock_movement where school_id = $1 and expiry is not null group by item_id, batch, expiry) x
                                join store_item i on i.id = x.item_id where x.left > 0 and x.expiry <= current_date + 60 order by x.expiry`, [schoolId]),
    services: await servicesDue(db, actor, schoolId),
    indentsWaiting: (await db.one<{ n: number }>(`select count(*)::int as n from indent where school_id = $1 and status in ('SUBMITTED', 'APPROVED')`, [schoolId])).n,
    owedPaise: Number((await db.one<{ n: string }>(`select coalesce(sum(amount_paise - paid_paise), 0) as n from goods_receipt where school_id = $1`, [schoolId])).n),
    assets: await db.one(`select count(*) filter (where status = 'IN_USE')::int as in_use, count(*) filter (where status = 'IN_REPAIR')::int as in_repair, count(*) filter (where status = 'MISSING')::int as missing,
                                  coalesce(sum(cost_paise - depreciated_paise) filter (where status <> 'DISPOSED'), 0)::float as book_value_paise from asset where school_id = $1`, [schoolId]),
  };
}
