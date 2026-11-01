import { beforeAll, describe, expect, it } from 'vitest';
import * as chat from '../src/modules/chat.js';
import { loadActor, type Actor } from '../src/modules/auth.js';
import { family, makeWorld, rejects, type World } from './helpers.js';
import * as cc from '../../web/src/lib/chatCrypto.ts';

/**
 * Staff chat, tested the way devices use it: every person makes a key pair and a PIN backup,
 * wraps conversation keys for the others and seals messages. The server only ever holds
 * ciphertext; these tests check it enforces the rules that keep that true.
 */

let w: World;
interface Device { actor: Actor; key: CryptoKey; keys: Map<string, Uint8Array> }
const people: Record<string, Device> = {};
const PIN = '482915';

const user = async (name: string, role: string, scope: string) =>
  loadActor(w.db, (await w.db.one<{ id: string }>(`insert into app_user (name, role, designation, scope_path) values ($1, $2, $1, $3) returning id`, [name, role, scope])).id);

async function setUp(actor: Actor): Promise<Device> {
  const { body, privateKey } = await cc.createIdentity(PIN);
  await chat.setIdentity(w.db, actor, body);
  return { actor, key: privateKey, keys: new Map() };
}

/** What a device does on opening a conversation: start a new key if needed, share it with anyone missing it, open its own keys. */
async function open(d: Device, conversationId: string) {
  let c = await chat.detail(w.db, d.actor, conversationId);
  const ready = c.members.filter((m) => m.public_key);
  if (c.needsEpoch > c.epoch) {
    const raw = cc.newConversationKey();
    const envelopes = await Promise.all(ready.map(async (m) => ({ userId: m.id, recipientKeyVersion: m.key_version!, ...(await cc.wrapKey(raw, d.key, m.public_key!, cc.keyInfo(conversationId, c.needsEpoch, m.id))) })));
    await chat.putKeys(w.db, d.actor, conversationId, { epoch: c.needsEpoch, envelopes });
    c = await chat.detail(w.db, d.actor, conversationId);
  }
  for (const k of c.myKeys as { epoch: number; wrappedKey: string; iv: string; wrapperPublicKey: string }[]) {
    d.keys.set(`${conversationId}:${k.epoch}`, await cc.unwrapKey(k.wrappedKey, k.iv, d.key, k.wrapperPublicKey, cc.keyInfo(conversationId, k.epoch, d.actor.id)));
  }
  const mine = d.keys.get(`${conversationId}:${c.epoch}`);
  if (mine && c.missing.length) {
    const envelopes = await Promise.all(ready.filter((m) => c.missing.includes(m.id)).map(async (m) => ({ userId: m.id, recipientKeyVersion: m.key_version!, ...(await cc.wrapKey(mine, d.key, m.public_key!, cc.keyInfo(conversationId, c.epoch, m.id))) })));
    await chat.putKeys(w.db, d.actor, conversationId, { epoch: c.epoch, envelopes });
  }
  return c;
}

async function say(d: Device, conversationId: string, body: string) {
  const c = await open(d, conversationId);
  const sealed = await cc.seal(d.keys.get(`${conversationId}:${c.epoch}`)!, { t: 'text', body }, cc.messageAad(conversationId, c.epoch, d.actor.id));
  return chat.send(w.db, d.actor, conversationId, { epoch: c.epoch, ...sealed });
}

/** The texts a device can read, in order; "?" where it holds no key. */
async function read(d: Device, conversationId: string) {
  await open(d, conversationId);
  const out: string[] = [];
  for (const m of await chat.messages(w.db, d.actor, conversationId) as { kind: string; epoch: number; iv: string; ciphertext: string; senderId: string; systemText: string; deleted: boolean }[]) {
    if (m.kind === 'SYSTEM') { out.push(`* ${m.systemText}`); continue; }
    if (m.deleted) { out.push('(deleted)'); continue; }
    const k = d.keys.get(`${conversationId}:${m.epoch}`);
    if (!k) { out.push('?'); continue; }
    const p = await cc.open(k, m.iv, m.ciphertext, cc.messageAad(conversationId, m.epoch, m.senderId));
    out.push(p.t === 'text' ? p.body : `[file ${p.name}]`);
  }
  return out;
}

beforeAll(async () => {
  w = await makeWorld();
  people.priya = await setUp(await user('Priya Teacher', 'TEACHER', 'nes.wnc.ncs_a'));
  people.rahul = await setUp(await user('Rahul Teacher', 'TEACHER', 'nes.wnc.ncs_a'));
  people.meena = await setUp(await user('Meena Bravo', 'TEACHER', 'nes.enc.ncs_b'));
  people.principal = await setUp(w.principalA);
  people.nes = await setUp(w.admin);
});

describe('the encryption on each device', () => {
  it('restores the private key with the PIN only; tampering or a wrong conversation is detected', async () => {
    const { body } = await cc.createIdentity('739105');
    await expect(cc.unlockIdentity(body, '739106')).rejects.toThrow(/PIN is not right/);
    const a = await cc.unlockIdentity(body, '739105');
    const b = await cc.createIdentity('555123');
    const raw = cc.newConversationKey();
    const env = await cc.wrapKey(raw, b.privateKey, body.publicKey, cc.keyInfo('c1', 1, 'alice'));
    expect(await cc.unwrapKey(env.wrappedKey, env.iv, a, b.body.publicKey, cc.keyInfo('c1', 1, 'alice'))).toEqual(raw);
    await expect(cc.unwrapKey(env.wrappedKey, env.iv, a, b.body.publicKey, cc.keyInfo('c1', 2, 'alice'))).rejects.toThrow();   // another epoch
    const s = await cc.seal(raw, { t: 'text', body: 'Staff meeting at 3' }, cc.messageAad('c1', 1, 'bob'));
    expect(await cc.open(raw, s.iv, s.ciphertext, cc.messageAad('c1', 1, 'bob'))).toEqual({ t: 'text', body: 'Staff meeting at 3' });
    await expect(cc.open(raw, s.iv, s.ciphertext, cc.messageAad('c1', 1, 'eve'))).rejects.toThrow();                            // claimed by another sender
    const bad = cc.unb64(s.ciphertext); bad[0] ^= 1;
    await expect(cc.open(raw, s.iv, cc.b64(bad), cc.messageAad('c1', 1, 'bob'))).rejects.toThrow();                             // altered
    const file = await cc.sealFile(new TextEncoder().encode('%PDF-1.7 timetable'));
    expect(new TextDecoder().decode(await cc.openFile(file.data, file.key, file.iv))).toBe('%PDF-1.7 timetable');
    expect(cc.pinProblem('123456')).toMatch(/harder/);
    expect(cc.pinProblem('1234')).toMatch(/6 to 12/);
    expect(body.fingerprint).toMatch(/^([0-9A-F]{5} ){5}[0-9A-F]{5}$/);
  });
});

describe('chats', () => {
  let dm: string;
  it('one-to-one, across schools: the same chat each time, readable only by the two', async () => {
    dm = (await chat.direct(w.db, people.priya.actor, people.meena.actor.id)).id;
    expect((await chat.direct(w.db, people.meena.actor, people.priya.actor.id)).id).toBe(dm);
    await say(people.priya, dm, 'Can you share the Class X science question bank?');
    await say(people.meena, dm, 'Sending it now');
    expect(await read(people.meena, dm)).toEqual(['Can you share the Class X science question bank?', 'Sending it now']);
    // What the server holds is not the text.
    const stored = await w.db.query<{ ciphertext: string }>('select ciphertext from chat_message where conversation_id = $1', [dm]);
    expect(stored.every((s) => !Buffer.from(s.ciphertext, 'base64').toString('latin1').includes('science'))).toBe(true);
    await rejects(chat.messages(w.db, people.rahul.actor, dm), /not in this conversation/);
    expect((await chat.unread(w.db, people.priya.actor)).unread).toBe(1);
    await chat.markRead(w.db, people.priya.actor, dm);
    expect((await chat.unread(w.db, people.priya.actor)).unread).toBe(0);
  });

  it('parents are not part of staff chat', async () => {
    const f = await family(w);
    await rejects(chat.conversations(w.db, f.parent), /Chat is for staff/);
    await rejects(chat.direct(w.db, people.priya.actor, f.parent.id), /Staff member/);
  });

  it('a group changes its key when people join or leave: newcomers do not read the past, leavers do not read the future', async () => {
    const g = (await chat.createGroup(w.db, people.priya.actor, { title: 'Class X teachers', memberIds: [people.rahul.actor.id] })).id;
    await say(people.priya, g, 'Pre-board papers due Friday');
    await chat.addMembers(w.db, people.priya.actor, g, [people.meena.actor.id]);
    // The old key cannot be used any more.
    const stale = await cc.seal(people.priya.keys.get(`${g}:1`)!, { t: 'text', body: 'old key' }, cc.messageAad(g, 1, people.priya.actor.id));
    await rejects(chat.send(w.db, people.priya.actor, g, { epoch: 1, ...stale }), /key changed/);
    await say(people.rahul, g, 'Welcome Meena');
    expect(await read(people.meena, g)).toEqual(['* Priya Teacher added Meena Bravo.', 'Welcome Meena']);     // nothing from before she joined
    await chat.removeMember(w.db, people.priya.actor, g, people.rahul.actor.id);
    await say(people.priya, g, 'Marks entry closes Monday');
    await rejects(chat.messages(w.db, people.rahul.actor, g), /not in this conversation/);
    // Even with an old key and the raw rows, Rahul holds no key for the new epoch.
    const keys = await w.db.query<{ epoch: number }>('select epoch from chat_key where conversation_id = $1 and user_id = $2', [g, people.rahul.actor.id]);
    expect(Math.max(...keys.map((k) => k.epoch))).toBe(2);
    expect((await chat.detail(w.db, people.priya.actor, g)).epoch).toBe(3);
    expect(await read(people.priya, g)).toEqual(['* Priya Teacher made the group "Class X teachers".', 'Pre-board papers due Friday', '* Priya Teacher added Meena Bravo.',
      'Welcome Meena', '* Priya Teacher removed Rahul Teacher.', 'Marks entry closes Monday']);
    await rejects(chat.addMembers(w.db, people.meena.actor, g, [people.rahul.actor.id]), /Only the group’s admins/);
  });

  it('someone who sets up chat later gets the current key from any member', async () => {
    const late = await user('Late Teacher', 'TEACHER', 'nes.wnc.ncs_a');
    const g = (await chat.createGroup(w.db, people.priya.actor, { title: 'Sports day', memberIds: [late.id, people.rahul.actor.id] })).id;
    await say(people.priya, g, 'Volunteers needed for the relay');
    const d = await setUp(late);
    expect((await chat.detail(w.db, late, g)).missing).toContain(late.id);
    await open(people.rahul, g);                                   // Rahul's device shares the key with her
    expect(await read(d, g)).toContain('Volunteers needed for the relay');
  });

  it('files are stored encrypted and only members of the chat can fetch them', async () => {
    const plain = new TextEncoder().encode('Name,Marks\nAarav,91');
    const f = await cc.sealFile(plain);
    const up = await chat.upload(w.db, people.priya.actor, dm, f.data);
    const c = await open(people.priya, dm);
    const sealed = await cc.seal(people.priya.keys.get(`${dm}:${c.epoch}`)!, { t: 'file', name: 'marks.csv', mime: 'text/csv', size: plain.length, key: f.key, iv: f.iv }, cc.messageAad(dm, c.epoch, people.priya.actor.id));
    await chat.send(w.db, people.priya.actor, dm, { epoch: c.epoch, ...sealed, attachmentId: up.id });
    const got = await chat.download(w.db, people.meena.actor, up.id);
    expect(Buffer.from(got).toString('latin1')).not.toContain('Aarav');
    expect(new TextDecoder().decode(await cc.openFile(new Uint8Array(got), f.key, f.iv))).toContain('Aarav,91');
    await rejects(chat.download(w.db, people.rahul.actor, up.id), /not in this conversation/);
    await rejects(chat.send(w.db, people.priya.actor, dm, { epoch: c.epoch, ...sealed, attachmentId: up.id }), /not uploaded/);   // a file goes with one message
    // Deleting erases the content for everyone.
    const last = (await chat.messages(w.db, people.priya.actor, dm)).at(-1) as { id: string };
    await rejects(chat.remove(w.db, people.meena.actor, last.id), /Only the sender/);
    await chat.remove(w.db, people.priya.actor, last.id);
    expect((await chat.download(w.db, people.meena.actor, up.id)).length).toBe(1);
    await rejects(w.db.query(`update chat_message set ciphertext = 'AAAA' where id = $1`, [last.id]), /deleted/);
  });

  it('keeps the school staff groups, the principals group and the NES and Command channels in step with the staff lists', async () => {
    await w.db.query(`insert into app_user (name, role, designation, scope_path) values ('Capt Command', 'COMMAND_OFFICER', 'Command Education Officer', 'nes.wnc')`);
    await chat.syncAutoGroups(w.db);
    const list = async (d: Actor) => (await chat.conversations(w.db, d) as { title: string; auto: string | null; can_post: boolean }[]).filter((c) => c.auto);
    const priya = await list(people.priya.actor);
    expect(priya.map((c) => c.title).sort()).toEqual(['All staff · NCS Alpha', 'NES announcements', 'Western Naval Command · announcements'].sort());
    expect(priya.find((c) => c.title === 'NES announcements')!.can_post).toBe(false);
    expect((await list(people.meena.actor)).map((c) => c.title)).toContain('All staff · NCS Bravo');
    expect((await list(people.principal.actor)).map((c) => c.title)).toContain('Principals of the Navy schools');
    const nesChannel = (await list(people.nes.actor)).find((c) => c.title === 'NES announcements') as unknown as { id: string };
    await say(people.nes, nesChannel.id, 'Annual sports meet: entries by 30 November');
    expect(await read(people.priya, nesChannel.id)).toContain('Annual sports meet: entries by 30 November');
    await rejects(say(people.priya, nesChannel.id, 'Hello'), /run this channel/);
    // Someone leaves the school: they leave its staff group, and its key moves on.
    const staffGroup = (await list(people.rahul.actor)).find((c) => c.auto === 'SCHOOL_STAFF') as unknown as { id: string };
    await say(people.priya, staffGroup.id, 'Fire drill tomorrow');
    await w.db.query('update app_user set active = false where id = $1', [people.rahul.actor.id]);
    await chat.syncAutoGroups(w.db);
    await rejects(chat.messages(w.db, people.rahul.actor, staffGroup.id), /not in this conversation/);
    await rejects(chat.removeMember(w.db, people.priya.actor, staffGroup.id, people.principal.actor.id), /follows the staff lists/);
  });

  it('a forgotten PIN can be reset: a new key, and everyone in the person’s chats is told', async () => {
    const before = (await chat.identity(w.db, people.meena.actor)) as { keyVersion: number };
    const { body, privateKey } = await cc.createIdentity('604213');
    await rejects(chat.setIdentity(w.db, people.meena.actor, body), /already set up/);
    expect(await chat.setIdentity(w.db, people.meena.actor, body, true)).toEqual({ keyVersion: before.keyVersion + 1 });
    people.meena.key = privateKey; people.meena.keys.clear();
    expect((await read(people.priya, dm)).at(-1)).toBe('* Meena Bravo\'s security key changed (a new device or a reset PIN).');
    await say(people.priya, dm, 'Can you read this?');                // Priya's device shares the key with Meena's new key
    expect((await read(people.meena, dm)).at(-1)).toBe('Can you read this?');
  });
});
