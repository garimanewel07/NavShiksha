import { readFileSync } from 'node:fs';

/**
 * The product's name and the official emblems. The Navy Education Society logo and the Navy
 * Children School logo are taken from nesnavy.in; a school or NES can upload a replacement under
 * Printing → School images, which then takes precedence.
 */
export const PRODUCT = 'NavShiksha';
export const SOCIETY = 'Navy Education Society';

const file = (name: string) => readFileSync(new URL(`../reference/brand/${name}`, import.meta.url));
let cache: { nes: Buffer; ncs: Buffer; nkg: Buffer } | null = null;
const files = () => (cache ??= { nes: file('nes-logo.png'), ncs: file('ncs-logo.jpg'), nkg: file('nkg-logo.png') });

export interface Emblem { type: string; data: Buffer }

/** The Navy Education Society emblem. */
export const nesEmblem = (): Emblem => ({ type: 'image/png', data: files().nes });

/**
 * The emblem a school uses when it has not uploaded its own: Navy Children Schools share one, the
 * Naval Kindergartens share theirs (taken from the kindergartens' own report cards).
 */
export const schoolEmblem = (schoolType: string | null): Emblem =>
  schoolType === 'NCS' ? { type: 'image/jpeg', data: files().ncs } : schoolType === 'NKG' ? { type: 'image/png', data: files().nkg } : nesEmblem();
