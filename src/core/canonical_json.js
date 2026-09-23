/**
 * Deterministic JSON serialization utility.
 *
 * Requirements:
 * - Object keys sorted lexicographically (recursive).
 * - Nested objects sorted recursively.
 * - Arrays retain their original order.
 * - No nondeterministic formatting or whitespace.
 * - UTF-8 output.
 * - Compact representation suitable for cryptographic hashing.
 */

/**
 * Serializes any JSON-compatible value to a deterministic, canonical JSON string.
 *
 * @param {unknown} value
 * @returns {string} Canonical JSON representation
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) =>
      canonicalJson(item === undefined ? null : item)
    );
    return `[${serializedItems.join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = [];

  for (const key of keys) {
    const val = value[key];
    if (val !== undefined) {
      pairs.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
    }
  }

  return `{${pairs.join(',')}}`;
}
