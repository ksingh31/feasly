/**
 * Builder partner store (#888).
 *
 * The Drizzle persistence boundary for `builder_partners`. The "active
 * only" filter for the public list lives HERE, in SQL — an inactive partner
 * never leaves the database on the public read path.
 *
 * Only services import from this module (layer boundary: routes never touch
 * the db directly).
 */
import { asc, eq, sql } from 'drizzle-orm';
import { builderPartners, builders } from '../db/schema';

export type BuilderPartnerRow = typeof builderPartners.$inferSelect;

export interface NewBuilderPartnerRow {
  readonly id: string;
  readonly builderId: string | null;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly websiteUrl: string | null;
  readonly description: string | null;
  readonly displayOrder: number;
  readonly active: boolean;
}

export type BuilderPartnerPatch = Partial<
  Omit<NewBuilderPartnerRow, 'id'>
>;

export interface BuilderPartnerStore {
  /** Every partner, display order then name. */
  listAll(): Promise<readonly BuilderPartnerRow[]>;
  /** Active partners only (filtered in SQL), display order then name. */
  listActive(): Promise<readonly BuilderPartnerRow[]>;
  /** One partner, or null. */
  get(id: string): Promise<BuilderPartnerRow | null>;
  /** Highest display_order in use, or -1 when there are no partners. */
  maxDisplayOrder(): Promise<number>;
  /** Whether a `builders` row with this id exists. */
  builderExists(builderId: string): Promise<boolean>;
  insert(row: NewBuilderPartnerRow): Promise<BuilderPartnerRow>;
  /** Applies the patch (and bumps updated_at); null when the id is unknown. */
  update(id: string, patch: BuilderPartnerPatch): Promise<BuilderPartnerRow | null>;
}

export interface DrizzleBuilderPartnerStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleBuilderPartnerStore(
  deps: DrizzleBuilderPartnerStoreDeps,
): BuilderPartnerStore {
  const { db } = deps;
  const order = [asc(builderPartners.displayOrder), asc(builderPartners.name)];

  return {
    async listAll() {
      return db.select().from(builderPartners).orderBy(...order);
    },

    async listActive() {
      return db
        .select()
        .from(builderPartners)
        .where(eq(builderPartners.active, true))
        .orderBy(...order);
    },

    async get(id) {
      const rows: BuilderPartnerRow[] = await db
        .select()
        .from(builderPartners)
        .where(eq(builderPartners.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async maxDisplayOrder() {
      const rows: Array<{ max: number | null }> = await db
        .select({ max: sql<number | null>`max(${builderPartners.displayOrder})` })
        .from(builderPartners);
      const max = rows[0]?.max;
      return max === null || max === undefined ? -1 : Number(max);
    },

    async builderExists(builderId) {
      const rows: Array<{ id: string }> = await db
        .select({ id: builders.id })
        .from(builders)
        .where(eq(builders.id, builderId))
        .limit(1);
      return rows.length > 0;
    },

    async insert(row) {
      const [inserted]: BuilderPartnerRow[] = await db
        .insert(builderPartners)
        .values({ ...row })
        .returning();
      if (!inserted) throw new Error('builder partner insert returned no row');
      return inserted;
    },

    async update(id, patch) {
      const [updated]: BuilderPartnerRow[] = await db
        .update(builderPartners)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(builderPartners.id, id))
        .returning();
      return updated ?? null;
    },
  };
}
