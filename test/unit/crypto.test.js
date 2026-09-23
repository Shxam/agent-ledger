import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, GENESIS_HASH } from '../../src/core/crypto.js';

describe('Cryptographic Foundation (SHA-256)', () => {
  it('computes the exact known GENESIS hash digest', () => {
    const expected = '901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a';
    assert.equal(GENESIS_HASH, expected);
    assert.equal(sha256('GENESIS'), expected);
  });

  it('computes correct standard test vectors', () => {
    // SHA-256("hello")
    const expectedHello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    assert.equal(sha256('hello'), expectedHello);

    // SHA-256("")
    const expectedEmpty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    assert.equal(sha256(''), expectedEmpty);
  });

  it('accepts Buffer and Uint8Array input', () => {
    const buf = Buffer.from('GENESIS', 'utf8');
    assert.equal(sha256(buf), GENESIS_HASH);

    const uint8 = new Uint8Array([0x47, 0x45, 0x4e, 0x45, 0x53, 0x49, 0x53]); // "GENESIS"
    assert.equal(sha256(uint8), GENESIS_HASH);
  });
});
