import { createPublicKey, type KeyObject } from 'node:crypto';

const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });

/** Public key có đúng là của private key này không: suy public từ private rồi so từng byte. */
export function isMatchingKeyPair(privateKey: KeyObject, publicKey: KeyObject): boolean {
  return spki(createPublicKey(privateKey)).equals(spki(publicKey));
}
