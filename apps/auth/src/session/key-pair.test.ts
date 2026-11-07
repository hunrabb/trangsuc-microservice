import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestKeys } from '@jewelry/test-utils';
import { isMatchingKeyPair } from './key-pair.ts';

describe('isMatchingKeyPair', () => {
  it('đúng cặp thì khớp, khác cặp thì không', () => {
    const { privateKey, publicKey } = createTestKeys();
    assert.equal(isMatchingKeyPair(privateKey, publicKey), true);
    assert.equal(isMatchingKeyPair(privateKey, createTestKeys().publicKey), false);
  });
});
