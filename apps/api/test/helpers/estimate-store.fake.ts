/**
 * Shared in-memory EstimateStore fake for tests (consumer/06).
 *
 * Implements the full EstimateStore interface including setNarrative.
 * Use this instead of hand-rolling fakes to avoid interface drift.
 */
import type {
  EstimateRecord,
  EstimateStore,
} from '../../src/services/estimate.store';

export interface InMemoryEstimateStore extends EstimateStore {
  readonly records: Map<string, EstimateRecord>;
}

export function createInMemoryEstimateStore(): InMemoryEstimateStore {
  const records = new Map<string, EstimateRecord>();
  return {
    records,
    async save(record: EstimateRecord): Promise<void> {
      records.set(record.id, record);
    },
    async findById(id: string): Promise<EstimateRecord | null> {
      return records.get(id) ?? null;
    },
    async setNarrative({
      id,
      narrative,
      generatedAt,
    }: {
      id: string;
      narrative: string;
      generatedAt: Date;
    }): Promise<boolean> {
      const rec = records.get(id);
      if (!rec || rec.narrative) return false;
      records.set(id, { ...rec, narrative, narrativeGeneratedAt: generatedAt });
      return true;
    },
    async findByAddressKey(addressKey: string): Promise<EstimateRecord[]> {
      return [...records.values()]
        .filter((r) => r.addressKey === addressKey)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}

/**
 * Create a minimal EstimateRecord for tests. Override fields as needed.
 */
export function makeEstimateRecord(
  overrides: Partial<EstimateRecord> = {},
): EstimateRecord {
  return {
    id: 'test-estimate-id',
    projectType: 'new_build',
    addressKey: 'test-address',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.1.0-unclibrated',
    createdAt: new Date(),
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
    ...overrides,
  };
}
