import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

/**
 * Password-protected zip files (WinZip AES-256, "AE-2"), which 7-Zip, WinRAR, macOS Archive
 * Utility (bsdtar) and Windows 11 open. Used for the CWT question papers sent to centres.
 *
 * Each file: a random 16-byte salt; PBKDF2-HMAC-SHA1 (1000 rounds) gives the AES key, the HMAC key
 * and a 2-byte password check; the deflated data is encrypted with AES-256 in counter mode (the
 * counter little-endian from 1); HMAC-SHA1 of the encrypted data, cut to 10 bytes, authenticates it.
 */

export interface ZipEntry { name: string; data: Buffer | Uint8Array; modified?: Date }

function aesCtr(key: Buffer, data: Buffer) {
  const blocks = Math.ceil(data.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let i = 0; i < blocks; i++) {
    let n = i + 1;
    for (let b = 0; b < 8 && n > 0; b++) { counters[i * 16 + b] = n & 0xff; n = Math.floor(n / 256); }
  }
  const ecb = createCipheriv('aes-256-ecb', key, null).setAutoPadding(false);
  const stream = Buffer.concat([ecb.update(counters), ecb.final()]);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  return out;
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip of the entries, every one encrypted with the password. */
export function encryptedZip(entries: ZipEntry[], password: string) {
  if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const plain = Buffer.from(e.data);
    const deflated = deflateRawSync(plain, { level: 9 });
    const salt = randomBytes(16);
    const k = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 66, 'sha1');
    const enc = aesCtr(k.subarray(0, 32), deflated);
    const mac = createHmac('sha1', k.subarray(32, 64)).update(enc).digest().subarray(0, 10);
    const body = Buffer.concat([salt, k.subarray(64, 66), enc, mac]);
    const extra = Buffer.alloc(11);
    extra.writeUInt16LE(0x9901, 0); extra.writeUInt16LE(7, 2); extra.writeUInt16LE(2, 4); extra.write('AE', 6, 'latin1'); extra.writeUInt8(3, 8); extra.writeUInt16LE(8, 9);
    const { time, date } = dosTime(e.modified ?? new Date());
    const flags = 0x0001 | 0x0800;                                   // encrypted, UTF-8 names
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(51, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(99, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(0, 14);   // AE-2: no CRC
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(51, 4); central.writeUInt16LE(51, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(99, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(0, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, body);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A password that reads well over SMS: 12 characters, no 0/O or 1/l/I. */
export function zipPassword() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const b = randomBytes(12);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}
