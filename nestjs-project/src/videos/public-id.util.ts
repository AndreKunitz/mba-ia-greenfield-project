import { randomBytes } from 'node:crypto';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH } from './videos.constants';

// 62 * 4 = 248: bytes at or above this value are discarded so that
// `byte % 62` stays uniformly distributed (rejection sampling, no modulo bias).
const MAX_UNBIASED_BYTE = PUBLIC_ID_ALPHABET.length * 4;

export function generatePublicId(): string {
  let id = '';
  while (id.length < PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(PUBLIC_ID_LENGTH * 2)) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      id += PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length];
      if (id.length === PUBLIC_ID_LENGTH) break;
    }
  }
  return id;
}
