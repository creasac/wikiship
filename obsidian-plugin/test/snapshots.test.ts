import { describe, expect, it } from 'vitest';
import { bytes, snapshot, textSnapshot } from '../src/model';

describe('lossless snapshot encoding', () => {
  it('rejects malformed Unicode or NUL in text mutation input instead of silently replacing it', () => {
    expect(() => textSnapshot('a\uD800b')).toThrow('valid Unicode');
    expect(() => textSnapshot('a\0b')).toThrow('NUL');
    const value = 'hello 🌏 — नेपाल';
    expect(textSnapshot(value).data).toBe(value);
  });
  it('preserves all bytes of binary files for delete and restore', () => {
    const original = Uint8Array.from([0, 255, 1, 254, 128, 65]);
    const saved = snapshot(original);
    expect(saved.encoding).toBe('base64');
    expect(bytes(saved)).toEqual(Buffer.from(original));
  });
});
