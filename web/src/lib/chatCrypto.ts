/**
 * End-to-end encryption for staff chat, with the browser's own WebCrypto (nothing to install).
 *
 * - Each person has an ECDH P-256 key pair made on their device. The private key is sent to the
 *   server only sealed with AES-GCM under a key derived from their chat PIN (PBKDF2-SHA-256,
 *   310,000 rounds), so it can be restored on a new device with the PIN and is useless without it.
 * - Each conversation key (AES-256-GCM, a new one whenever members change) is wrapped for every
 *   member: ECDH between the wrapper's private key and the member's public key, then HKDF bound to
 *   the conversation, the key epoch and the member, then AES-GCM.
 * - Messages and file details are sealed with the conversation key, bound to the conversation,
 *   epoch and sender, so ciphertext cannot be replayed elsewhere or attributed to someone else.
 * - Files are sealed with their own one-time key, which travels inside the (sealed) message.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
export const PIN_ITERATIONS = 310_000;

export const b64 = (data: ArrayBuffer | Uint8Array) => {
  const a = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
/** WebCrypto takes any byte array; newer TypeScript wants that said explicitly. */
const bytes = (u: Uint8Array) => u as unknown as BufferSource;

export interface IdentityBody { publicKey: string; keyBackup: string; backupSalt: string; backupIv: string; backupIterations: number; fingerprint: string }

/** The PIN: at least 6 digits, not all the same and not a simple run. */
export function pinProblem(pin: string) {
  if (!/^\d{6,12}$/.test(pin)) return 'Use 6 to 12 digits.';
  if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin)) return 'Choose a PIN that is harder to guess.';
  return null;
}

async function pinKey(pin: string, salt: Uint8Array, iterations: number) {
  const base = await subtle.importKey('raw', bytes(enc.encode(pin)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** A short code two people can read to each other to check they have each other's real key. */
export async function fingerprint(publicKey: string) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes(unb64(publicKey))));
  const hex = [...h.slice(0, 15)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,5}/g)!.join(' ');
}

/** A new key pair; returns what the server keeps (public key, PIN-sealed private key) and the private key for this device. */
export async function createIdentity(pin: string) {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair;
  const publicKey = b64(await subtle.exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  const salt = random(16), iv = random(12);
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, await pinKey(pin, salt, PIN_ITERATIONS), bytes(pkcs8));
  const privateKey = await subtle.importKey('pkcs8', bytes(pkcs8), ECDH, false, ['deriveBits']);
  pkcs8.fill(0);
  const body: IdentityBody = { publicKey, keyBackup: b64(sealed), backupSalt: b64(salt), backupIv: b64(iv), backupIterations: PIN_ITERATIONS, fingerprint: await fingerprint(publicKey) };
  return { body, privateKey };
}

/** Opens the PIN-sealed private key on a new device. A wrong PIN fails. */
export async function unlockIdentity(identity: IdentityBody, pin: string) {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes(unb64(identity.backupIv)) }, await pinKey(pin, unb64(identity.backupSalt), identity.backupIterations), bytes(unb64(identity.keyBackup))));
  } catch { throw new Error('That PIN is not right.'); }
  const privateKey = await subtle.importKey('pkcs8', bytes(pkcs8), ECDH, false, ['deriveBits']);
  pkcs8.fill(0);
  return privateKey;
}

export const keyInfo = (conversationId: string, epoch: number, recipientId: string) => `navshiksha-chat-v1|key|${conversationId}|${epoch}|${recipientId}`;
export const messageAad = (conversationId: string, epoch: number, senderId: string) => `navshiksha-chat-v1|msg|${conversationId}|${epoch}|${senderId}`;

async function pairKey(myPrivate: CryptoKey, theirPublic: string, info: string) {
  const pub = await subtle.importKey('spki', bytes(unb64(theirPublic)), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, myPrivate, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(new Uint8Array(32)), info: bytes(enc.encode(info)) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** A fresh conversation key (32 random bytes). */
export const newConversationKey = () => random(32);

export async function wrapKey(raw: Uint8Array, myPrivate: CryptoKey, theirPublic: string, info: string) {
  const iv = random(12);
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, await pairKey(myPrivate, theirPublic, info), bytes(raw));
  return { wrappedKey: b64(wrapped), iv: b64(iv) };
}

export async function unwrapKey(wrappedKey: string, iv: string, myPrivate: CryptoKey, wrapperPublic: string, info: string) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes(unb64(iv)) }, await pairKey(myPrivate, wrapperPublic, info), bytes(unb64(wrappedKey))));
}

const aesKey = (raw: Uint8Array) => subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** What a message carries, once opened. */
export type Payload =
  | { t: 'text'; body: string }
  | { t: 'file'; name: string; mime: string; size: number; key: string; iv: string; caption?: string };

export async function seal(raw: Uint8Array, payload: Payload, aad: string) {
  const iv = random(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(enc.encode(aad)) }, await aesKey(raw), bytes(enc.encode(JSON.stringify(payload))));
  return { iv: b64(iv), ciphertext: b64(ct) };
}

export async function open(raw: Uint8Array, iv: string, ciphertext: string, aad: string): Promise<Payload> {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes(unb64(iv)), additionalData: bytes(enc.encode(aad)) }, await aesKey(raw), bytes(unb64(ciphertext)));
  return JSON.parse(dec.decode(pt));
}

/** Seals a file with its own key; the key and IV go inside the sealed message. */
export async function sealFile(data: Uint8Array) {
  const key = random(32), iv = random(12);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, await aesKey(key), bytes(data)));
  return { data: sealed, key: b64(key), iv: b64(iv) };
}

export async function openFile(data: Uint8Array, key: string, iv: string) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes(unb64(iv)) }, await aesKey(unb64(key)), bytes(data)));
}
