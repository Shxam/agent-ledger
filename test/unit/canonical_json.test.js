import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../src/core/canonical_json.js';

describe('Deterministic JSON Serializer', () => {
  it('normalizes object key order lexicographically', () => {
    const obj1 = { z: 26, a: 1, m: 13 };
    const obj2 = { a: 1, m: 13, z: 26 };
    const obj3 = { m: 13, z: 26, a: 1 };

    const expected = '{"a":1,"m":13,"z":26}';
    assert.equal(canonicalJson(obj1), expected);
    assert.equal(canonicalJson(obj2), expected);
    assert.equal(canonicalJson(obj3), expected);
  });

  it('recursively sorts nested objects', () => {
    const nested = {
      run: {
        id: 'run_123',
        status: 'active',
        meta: { z_key: true, a_key: false },
      },
      alpha: 1,
    };

    const expected = '{"alpha":1,"run":{"id":"run_123","meta":{"a_key":false,"z_key":true},"status":"active"}}';
    assert.equal(canonicalJson(nested), expected);
  });

  it('preserves array element order without sorting', () => {
    const data = {
      items: [3, 1, 2, 'z', 'a'],
      nested: [{ b: 2, a: 1 }, { y: 4, x: 3 }],
    };

    const expected = '{"items":[3,1,2,"z","a"],"nested":[{"a":1,"b":2},{"x":3,"y":4}]}';
    assert.equal(canonicalJson(data), expected);
  });

  it('handles primitive types correctly: strings, numbers, booleans, null', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson(-3.1415), '-3.1415');
    assert.equal(canonicalJson('hello world'), '"hello world"');
  });

  it('handles unicode, emojis and escape characters in strings', () => {
    const data = {
      message: 'Hello 🚀 UTF-8: 日本語, é, ü\n\t"quotes"',
    };
    const serialized = canonicalJson(data);
    assert.ok(serialized.includes('🚀'));
    assert.ok(serialized.includes('日本語'));
    // Ensure it can be parsed back losslessly
    assert.deepEqual(JSON.parse(serialized), data);
  });

  it('produces identical compact representations on repeated runs', () => {
    const complex = {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: 'run_alpha',
      payload: {
        command: 'build',
        args: ['--release', '--verbose'],
        env: { PATH: '/bin', CC: 'gcc' },
      },
    };

    const first = canonicalJson(complex);
    for (let i = 0; i < 50; i++) {
      assert.equal(canonicalJson(complex), first);
    }
  });
});
