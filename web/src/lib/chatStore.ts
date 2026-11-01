/**
 * Keeps the chat private key on this device (IndexedDB), as a non-extractable WebCrypto key:
 * scripts on the page can use it but cannot read it out. Signing out of chat removes it.
 */

const DB = 'navshiksha-chat', STORE = 'device';

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

export interface DeviceKey { keyVersion: number; privateKey: CryptoKey }

export const loadDeviceKey = async (userId: string) => {
  try { return (await tx<DeviceKey | undefined>('readonly', (s) => s.get(userId))) ?? null; } catch { return null; }
};
export const saveDeviceKey = (userId: string, k: DeviceKey) => tx('readwrite', (s) => s.put(k, userId));
export const forgetDeviceKey = (userId: string) => tx('readwrite', (s) => s.delete(userId));
