import { vi, type Mock } from 'vitest';

type ObjectUrlKey = 'createObjectURL' | 'revokeObjectURL';

export interface ObjectUrlStub {
  createObjectURL: Mock<(obj: Blob | MediaSource) => string>;
  revokeObjectURL: Mock<(url: string) => void>;
  /** Puts the original URL.createObjectURL / revokeObjectURL back. */
  restore: () => void;
}

/**
 * Test-only stub for the URL.createObjectURL / revokeObjectURL download
 * plumbing (#744). Defines both as writable + configurable so later specs
 * in the same worker can still assign, spy on, or redefine them, and
 * `restore()` reinstates the original descriptors so nothing leaks between
 * spec files regardless of test order. Call `restore()` in `afterEach`
 * (or a `finally`).
 */
export function stubObjectUrls(blobUrl = 'blob:mock'): ObjectUrlStub {
  const keys: ObjectUrlKey[] = ['createObjectURL', 'revokeObjectURL'];
  const originals = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(URL, k)] as const));
  const createObjectURL = vi.fn((_obj: Blob | MediaSource) => blobUrl);
  const revokeObjectURL = vi.fn((_url: string) => undefined);
  const stubs: Record<ObjectUrlKey, unknown> = { createObjectURL, revokeObjectURL };
  for (const k of keys) {
    Object.defineProperty(URL, k, { value: stubs[k], configurable: true, writable: true });
  }
  let restored = false;
  return {
    createObjectURL,
    revokeObjectURL,
    restore: () => {
      if (restored) return;
      restored = true;
      for (const k of keys) {
        const original = originals.get(k);
        if (original) {
          Object.defineProperty(URL, k, original);
        } else {
          delete (URL as unknown as Record<string, unknown>)[k];
        }
      }
    },
  };
}
