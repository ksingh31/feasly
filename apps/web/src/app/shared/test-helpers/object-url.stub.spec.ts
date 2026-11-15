import { afterEach, describe, expect, it } from 'vitest';
import { stubObjectUrls } from './object-url.stub';

describe('stubObjectUrls (#744)', () => {
  const before = {
    create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };

  afterEach(() => {
    // Every test must leave the global exactly as it found it.
    expect(Object.getOwnPropertyDescriptor(URL, 'createObjectURL')).toEqual(before.create);
    expect(Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')).toEqual(before.revoke);
  });

  it('replaces both functions with spies returning the given blob URL', () => {
    const stub = stubObjectUrls('blob:test');
    try {
      expect(URL.createObjectURL(new Blob(['x']))).toBe('blob:test');
      URL.revokeObjectURL('blob:test');
      expect(stub.createObjectURL).toHaveBeenCalledTimes(1);
      expect(stub.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    } finally {
      stub.restore();
    }
  });

  it('leaves the stubs writable so plain assignment still works (the #744 failure)', () => {
    const stub = stubObjectUrls();
    try {
      const replacement = (): void => undefined;
      expect(() => Object.assign(URL, { revokeObjectURL: replacement })).not.toThrow();
      expect(URL.revokeObjectURL).toBe(replacement);
    } finally {
      stub.restore();
    }
  });

  it('restores the originals even when stubbed twice, and restore() is idempotent', () => {
    const outer = stubObjectUrls('blob:outer');
    const inner = stubObjectUrls('blob:inner');
    expect(URL.createObjectURL(new Blob(['x']))).toBe('blob:inner');
    inner.restore();
    inner.restore();
    expect(URL.createObjectURL(new Blob(['x']))).toBe('blob:outer');
    outer.restore();
  });
});
